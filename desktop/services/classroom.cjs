'use strict';

const { setTimeout: delay } = require('node:timers/promises');

const ORIGIN = 'https://changjiang.yuketang.cn';
const PARTITION = 'persist:rainclassroom';

function requestSignal(milliseconds, signal) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function signInRequired() {
  return Object.assign(new Error('请在软件内登录雨课堂后重试。'), { code: 'LOGIN_REQUIRED' });
}

function connection(session) {
  async function credentials(url) {
    const cookies = await session.cookies.get({ url });
    cookies.sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0));
    return {
      cookie: cookies.map((entry) => `${entry.name}=${entry.value}`).join('; '),
      'x-csrftoken': cookies.find((entry) => entry.name === 'csrftoken')?.value ?? ''
    };
  }

  async function request(route, parameters, { headers, signal } = {}) {
    const url = new URL(route, ORIGIN);
    url.search = new URLSearchParams(parameters);

    for (let attempt = 0; ; attempt++) {
      try {
        signal?.throwIfAborted();
        const sessionHeaders = await credentials(url.href);
        signal?.throwIfAborted();
        const response = await session.fetch(url.href, {
          credentials: 'omit', redirect: 'manual', signal: requestSignal(18000, signal),
          headers: { accept: 'application/json', xtbz: 'ykt', ...sessionHeaders, ...headers }
        });
        if (response.status === 401 || response.status === 403 || response.status === 0 ||
            (response.status >= 300 && response.status < 400)) throw signInRequired();
        if (!response.ok) throw new Error(`雨课堂暂时无法响应（${response.status}）`);
        if (response.headers.get('content-type')?.includes('text/html')) throw signInRequired();
        const body = await response.json();
        const code = Number(body.errcode ?? body.code ?? 0);
        if (String(code).startsWith('401')) throw signInRequired();
        if (code) throw new Error(`雨课堂返回错误（${code}）`);
        return body;
      } catch (error) {
        signal?.throwIfAborted();
        if (error.code === 'LOGIN_REQUIRED') throw error;
        if (attempt === 0) {
          await delay(900, undefined, { signal });
          continue;
        }
        if (error.message.startsWith('雨课堂')) throw error;
        throw new Error('无法读取雨课堂数据，请检查网络后重试。', { cause: error });
      }
    }
  }

  async function courses() {
    const { data } = await request('/v2/api/web/courses/list', { identity: 2 });
    if (!Array.isArray(data?.list)) throw new Error('雨课堂返回的课程列表无法读取。');
    return data.list.filter((entry) => entry?.classroom_id != null && entry.course?.id != null).map((entry) => ({
      id: String(entry.classroom_id), title: entry.course.name || '未命名课程',
      group: entry.name || '', teacher: entry.teacher?.name || ''
    }));
  }

  async function lessons(classroom) {
    const { data: info } = await request(`/v2/api/web/classrooms/${encodeURIComponent(classroom.id)}`, { role: 5 });
    if (!info?.course_sign) throw new Error('缺少课程信息');
    const { data } = await request('/mooc-api/v1/lms/learn/course/chapter', {
      cid: classroom.id, sign: info.course_sign, term: 'latest', uv_id: info.uv_id ?? '', classroom_id: classroom.id
    }, { headers: { 'x-client': 'web', 'terminal-type': 'web' } });
    if (!Array.isArray(data?.course_chapter)) throw new Error('课件列表无法读取');
    const unique = new Map();
    for (const chapter of data.course_chapter) {
      for (const leaf of chapter.section_leaf_list ?? []) {
        if (Number(leaf.leaf_type) !== 8 || leaf.id == null) continue;
        const id = String(leaf.id);
        unique.set(id, { id, title: leaf.name || '未命名课件', format: 'pdf' });
      }
    }
    return [...unique.values()];
  }

  async function slides(classroomId, lessonId, signal) {
    signal?.throwIfAborted();
    const options = { signal };
    const [university] = await session.cookies.get({ url: ORIGIN, name: 'uv_id' });
    const lesson = await request('/edu_admin/leaf_level_info/', {
      leaf_level_id: lessonId, no_loading: 'false', term: 'latest', uv_id: university?.value ?? '', classroom_id: classroomId
    }, options);
    if (!lesson.courseware_id) return [];
    const lesson_id = lesson.courseware_id;
    const { data: report } = await request('/api/v3/classroom-report/student/review', { lesson_id, front_time: Date.now() }, options);
    const presentations = new Set((report?.timelineList ?? []).map((entry) => entry.presentationId).filter(Boolean));
    const pages = [];
    for (const presentationId of presentations) {
      const { data } = await request('/api/v3/classroom-report/student/ppt', { lesson_id, presentationId, front_time: Date.now() }, options);
      pages.push(...(data?.slideList ?? []).map((entry) => entry.cover));
    }
    return pages;
  }

  async function attachment(address, signal) {
    signal?.throwIfAborted();
    const url = URL.parse(address);
    if (!url || url.protocol !== 'https:' || url.username || url.password) throw new Error('课件地址无效');
    const headers = url.origin === ORIGIN ? await credentials(url.href) : {};
    signal?.throwIfAborted();
    const response = await session.fetch(url.href, { credentials: 'omit', redirect: 'error', signal: requestSignal(30000, signal), headers });
    if (!response.ok) throw new Error('无法下载课件');
    return Buffer.from(await response.arrayBuffer());
  }

  return { courses, lessons, slides, attachment };
}

module.exports = { connection, ORIGIN, PARTITION };
