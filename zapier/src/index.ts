import zapier, { defineApp } from 'zapier-platform-core';

import { VERSION, addHeaders } from './api.js';
import { authentication } from './authentication.js';
import { cancelTask } from './creates/cancelTask.js';
import { createTask } from './creates/createTask.js';
import { createTaskWait } from './creates/createTaskWait.js';
import { findTask } from './searches/findTask.js';
import { taskFinished } from './triggers/taskFinished.js';

export default defineApp({
  version: VERSION,
  platformVersion: zapier.version,

  authentication,
  beforeRequest: [addHeaders],

  triggers: {
    [taskFinished.key]: taskFinished,
  },
  creates: {
    [createTask.key]: createTask,
    [createTaskWait.key]: createTaskWait,
    [cancelTask.key]: cancelTask,
  },
  searches: {
    [findTask.key]: findTask,
  },
});
