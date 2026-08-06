import { registerPlugin } from '@capacitor/core';
import { buildNativeCollectorScript } from '../collector.js';

const PageCollector = registerPlugin('PageCollector');

export async function collectRenderedPage(targetUrl, { silent = false } = {}) {
  return PageCollector.collect({
    url: targetUrl,
    script: buildNativeCollectorScript(),
    silent,
  });
}
