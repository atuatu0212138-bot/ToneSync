/** 统计量 Worker：主线程传缩略图 ImageData 像素，返回 Lab 均值/标准差（PRD §7）。 */
import { labStats } from './color.js';

self.onmessage = (e) => {
  const { id, pixels } = e.data;
  self.postMessage({ id, stats: labStats(pixels) });
};
