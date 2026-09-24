import { findBrowser } from './bridge/notch-window.mjs';
import { spawn } from 'node:child_process';
const sep = String.fromCharCode(92);
const page = 'file:///' + String(process.env.SP).split(sep).join('/') + '/drag.html';
spawn(findBrowser(), [`--app=${page}`, '--window-position=100,60', '--window-size=900,800'],
  { detached: true, stdio: 'ignore' }).unref();
console.log('opened', page);
