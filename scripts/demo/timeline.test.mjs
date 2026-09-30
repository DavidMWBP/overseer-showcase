import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDemo } from './demo.mjs';

test('runs the scripted demo from chat request through batch merge', async () => {
  const demo = await startDemo();
  let cleanup;
  try {
    const request = await demo.step('feature-request');
    assert.equal(request.chat.userText, demo.timeline.request.text);

    const planned = await demo.step('batch-created');
    assert.match(planned.chat.assistantText, /three tasks/i);
    assert.equal(planned.batch.taskTitles.length, 3);
    assert.equal(planned.batch.tasks.filter((task) => task.status === 'in_progress').length, 2);
    assert.equal(planned.batch.tasks.filter((task) => task.column === 'blocked').length, 1);

    const running = await demo.step('workers-running');
    assert.equal(running.batch.tasks.filter((task) => task.status === 'in_progress').length, 2);
    assert.equal(running.office.visibleCharacterCount, 2);
    assert.equal(running.office.walkingCharacterCount, 2);
    assert.equal(running.office.typingCharacterCount, 2);

    const finding = await demo.step('review-finding');
    assert.match(finding.chat.reviewNotice, /review round 1 .* found issues; re-dispatched/i);
    assert.equal(finding.batch.tasks.find((task) => task.title === demo.timeline.tasks[0].title).workerAttempts, 2);
    assert.equal(finding.batch.tasks.find((task) => task.title === demo.timeline.tasks[0].title).status, 'in_progress');

    const fixed = await demo.step('fix-lands');
    assert.equal(fixed.batch.tasks.find((task) => task.title === demo.timeline.tasks[0].title).column, 'done');
    assert.equal(fixed.batch.tasks.find((task) => task.title === demo.timeline.tasks[0].title).workerAttempts, 2);

    const review = await demo.step('batch-review');
    assert.equal(review.batch.status, 'review');
    assert.equal(review.batch.tasks.filter((task) => task.status === 'closed').length, 3);
    assert.equal(review.batch.note, demo.timeline.reviewNote);
    assert.ok(review.batch.cost > 0);
    assert.equal(review.ui.reviewNoteVisible, true);
    assert.match(review.ui.reviewCostText, /\$[\d,]+\.\d{2}/);

    const merged = await demo.step('merge');
    assert.equal(merged.batch.status, 'merged');
    assert.equal(merged.git.baseBranch, demo.timeline.baseBranch);
    assert.deepEqual(merged.git.mergedFiles.sort(), demo.timeline.tasks.map((task) => task.file).sort());
    assert.equal(merged.git.repairedControlNamed, true);
  } finally {
    cleanup = await demo.close();
  }

  assert.equal(cleanup.demoProcessesRemaining.length, 0);
  assert.equal(cleanup.tempDirRemoved, true);
  assert.equal(cleanup.dataDirRemoved, true);
  assert.equal(cleanup.repoDirRemoved, true);
  assert.ok(cleanup.checkedProcesses.length > 2);
  assert.ok(cleanup.checkedProcesses.every((process) => !process.alive));
  assert.equal(cleanup.port, demo.port);
  assert.notEqual(cleanup.port, 4400);
  assert.notEqual(cleanup.webPort, 5173);
  assert.notEqual(cleanup.webPort, 5174);
  assert.notEqual(cleanup.dataDir, demo.liveDataDir);
  assert.match(cleanup.runLog, /temp daemon port: \d+/);
  assert.match(cleanup.runLog, /temp data dir:/);
  assert.match(cleanup.runLog, /checked demo processes:/);
  assert.match(cleanup.runLog, /not-live assertions: PASS/);
});
