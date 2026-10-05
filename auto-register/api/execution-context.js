import { AsyncLocalStorage } from 'node:async_hooks';
export const workflowContext=new AsyncLocalStorage();
