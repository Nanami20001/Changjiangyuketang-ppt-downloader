'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { indexLessons, isActiveJob, resourceKey } = require('./library.cjs');

const waiting = { status: 'queued', progress: 0, detail: '等待导出', destination: undefined };

function createDownloadQueue({ data, save, runExport, onChange, onLoginRequired }) {
  let processing = false;
  let current;
  const nextJob = () => data.jobs.find((job) => job.status === 'queued');
  const jobKey = (job) => resourceKey(job.courseId, job.lesson.id);

  function publish() {
    try { save(); }
    catch (error) { console.error('保存下载记录失败', error); }
    onChange();
  }

  function createExportControl(job) {
    // Pausing interrupts transfers. Only cancelling ends the export itself.
    const cancellation = new AbortController();
    let transfer = new AbortController();
    let paused;

    async function checkpoint() {
      while (paused) await paused.promise;
      cancellation.signal.throwIfAborted();
    }

    function releasePause() {
      paused?.resolve();
      paused = undefined;
    }

    async function request(operation) {
      while (true) {
        await checkpoint();
        const signal = transfer.signal;
        try {
          const result = await operation(signal);
          await checkpoint();
          return result;
        } catch (error) {
          cancellation.signal.throwIfAborted();
          if (!signal.aborted) throw error;
        }
      }
    }

    return {
      job, signal: cancellation.signal, checkpoint, request,
      async beginSave() {
        await checkpoint();
        job.status = 'saving';
        onChange();
      },
      pause() {
        job.status = 'paused';
        paused = Promise.withResolvers();
        transfer.abort();
      },
      resume() {
        job.status = 'working';
        transfer = new AbortController();
        releasePause();
      },
      cancel() {
        Object.assign(job, { status: 'cancelled', detail: '' });
        cancellation.abort();
        transfer.abort();
        releasePause();
      }
    };
  }

  async function processQueue() {
    publish();
    if (processing) return;
    processing = true;
    try {
      let job;
      while ((job = nextJob())) {
        const control = current = createExportControl(job);
        Object.assign(job, { status: 'working', detail: '正在准备导出' });
        onChange();
        try {
          const result = await runExport(job, (detail, progress) => {
            if (job.status !== 'working') return;
            Object.assign(job, { detail, progress });
            onChange();
          }, control);
          await control.checkpoint();
          Object.assign(job, result, { status: result.missing ? 'partial' : 'complete', progress: 100 });
          job.detail = result.missing ? `已导出 ${result.pages} 页，缺少 ${result.missing} 页` : result.pages ? `已保存 ${result.pages} 页 PDF` : '文件已保存';
        } catch (error) {
          if (!control.signal.aborted) {
            if (error.code === 'LOGIN_REQUIRED') onLoginRequired();
            job.status = 'failed';
            job.detail = error.code && error.code !== 'LOGIN_REQUIRED' ? '无法写入保存位置，请检查目录和磁盘空间。' : error.message;
          }
        }
        current = undefined;
        publish();
        if (nextJob()) await delay(320);
      }
    } finally { processing = false; }
  }

  function changeCurrent(id, action, allowedStatuses) {
    if (!current || current.job.id !== id || !allowedStatuses.includes(current.job.status)) return;
    current[action]();
    publish();
  }

  function enqueue(keys, historyTime) {
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) throw new Error('课件选择无效');
    const source = historyTime == null ? data.courses : data.history.find((entry) => entry.time === historyTime)?.added ?? [];
    const available = indexLessons(source);
    const pending = new Set(data.jobs.filter(isActiveJob).map(jobKey));
    const now = Date.now();
    const queued = [];
    for (const key of new Set(keys)) {
      const target = available.get(key);
      if (!target || pending.has(key)) continue;
      queued.push({ ...target, ...waiting, id: randomUUID(), time: now });
    }
    if (queued.length) {
      data.jobs.push(...queued);
      void processQueue();
    }
    return queued.length;
  }

  function retry(id) {
    const job = data.jobs.find((entry) => entry.id === id);
    if (!job || !['failed', 'partial'].includes(job.status)) return;
    const key = jobKey(job);
    if (data.jobs.some((entry) => isActiveJob(entry) && jobKey(entry) === key)) return;
    Object.assign(job, waiting);
    void processQueue();
  }

  return {
    enqueue, retry,
    pause: (id) => changeCurrent(id, 'pause', ['working']),
    resume: (id) => changeCurrent(id, 'resume', ['paused']),
    cancel: (id) => changeCurrent(id, 'cancel', ['working', 'paused'])
  };
}

module.exports = { createDownloadQueue };
