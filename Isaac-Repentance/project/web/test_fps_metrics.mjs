import assert from 'node:assert/strict';
import {createFpsMetrics,FPS_MAX_SAMPLES,FPS_WINDOW_MS} from './fps_metrics.mjs';

let checks=0;
function test(name,run){run();checks++;console.log('PASS',name);}
function close(actual,expected){assert(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);}
function feed(metrics,intervals,start=0){metrics.record(start);for(const elapsed of intervals){start+=elapsed;assert.equal(metrics.record(start),true);}return start;}

test('No invented FPS before the first complete eligible frame',()=>{
  const metrics=createFpsMetrics();let result=metrics.snapshot();
  for(const key of ['currentFps','averageFps','low1Fps','low01Fps','frameTimeMs'])assert.equal(result[key],null);
  assert.equal(result.sampleCount,0);assert.equal(result.sampling,false);
  assert.equal(metrics.record(500),false);result=metrics.snapshot();assert.equal(result.currentFps,null);assert.equal(result.sampling,true);
  metrics.record(520);result=metrics.snapshot();close(result.currentFps,50);close(result.averageFps,50);close(result.frameTimeMs,20);
});

test('1% and 0.1% Low stay unavailable until their minimum sample counts',()=>{
  const metrics=createFpsMetrics();let time=feed(metrics,Array(99).fill(10));
  assert.equal(metrics.snapshot().low1Fps,null);assert.equal(metrics.snapshot().low01Fps,null);
  metrics.record(time+=10);close(metrics.snapshot().low1Fps,100);assert.equal(metrics.snapshot().low01Fps,null);
  for(let i=0;i<899;i++)metrics.record(time+=10);
  assert.equal(metrics.snapshot().low01Fps,null);metrics.record(time+=10);close(metrics.snapshot().low01Fps,100);
});

test('Low values average the slowest frame times rather than taking a minimum or percentile',()=>{
  const metrics=createFpsMetrics();feed(metrics,[...Array(990).fill(10),...Array(9).fill(100),1000]);
  const result=metrics.snapshot();assert.equal(result.sampleCount,1000);close(result.sampleDurationMs,11800);
  close(result.averageFps,1000000/11800);close(result.frameTimeMs,11.8);
  close(result.low1Fps,10000/1900);close(result.low01Fps,1);
  close(result.currentFps,1);assert.equal(result.currentSampleCount,1);
});

test('Current FPS uses the trailing second of complete intervals and a time-weighted rate',()=>{
  const metrics=createFpsMetrics();let time=feed(metrics,Array(100).fill(10));
  for(let i=0;i<50;i++)metrics.record(time+=20);
  const result=metrics.snapshot();close(result.currentFps,50);close(result.currentDurationMs,1000);
  assert.equal(result.currentSampleCount,50);close(result.averageFps,75);
});

test('Host pause, native pause and loading gaps do not become slow frames',()=>{
  const metrics=createFpsMetrics();feed(metrics,[16,16]);metrics.breakSampling();
  assert.equal(metrics.snapshot().sampling,false);assert.equal(metrics.record(50000),false);metrics.record(50016);
  metrics.record(70000,false);metrics.record(90000,false);assert.equal(metrics.record(100000),false);metrics.record(100016);
  const result=metrics.snapshot();assert.equal(result.sampleCount,4);close(result.sampleDurationMs,64);close(result.low1Fps??0,0);close(result.averageFps,62.5);
});

test('Pauses retain recent gameplay history without advancing its 60-second window',()=>{
  const metrics=createFpsMetrics();let time=feed(metrics,Array(200).fill(20));const before=metrics.snapshot();
  metrics.record(time+600000,false);metrics.record(time+1200000);
  const after=metrics.snapshot();assert.equal(after.sampleCount,before.sampleCount);close(after.sampleDurationMs,before.sampleDurationMs);close(after.low1Fps,before.low1Fps);
});

test('Rolling history evicts old frames while keeping the boundary frame',()=>{
  const metrics=createFpsMetrics();let time=feed(metrics,Array(6000).fill(10));
  assert.equal(metrics.snapshot().sampleCount,6000);close(metrics.snapshot().sampleDurationMs,FPS_WINDOW_MS);
  metrics.record(time+=15);const result=metrics.snapshot();
  assert.equal(result.sampleCount,6000);close(result.sampleDurationMs,60005);
  metrics.record(time+=5);close(metrics.snapshot().sampleDurationMs,60000);
});

test('High-frequency history has a fixed memory/sample bound',()=>{
  const metrics=createFpsMetrics();feed(metrics,Array(FPS_MAX_SAMPLES+3000).fill(1));
  const result=metrics.snapshot();assert.equal(result.sampleCount,FPS_MAX_SAMPLES);close(result.sampleDurationMs,FPS_MAX_SAMPLES);close(result.currentFps,1000);
});

test('Real stutters, including a frame longer than the history window, are retained',()=>{
  const metrics=createFpsMetrics();let time=feed(metrics,[10,10,120000]);
  let result=metrics.snapshot();assert.equal(result.sampleCount,1);close(result.sampleDurationMs,120000);close(result.currentFps,1/120);
  for(let i=0;i<100;i++)metrics.record(time+=10);
  result=metrics.snapshot();assert.equal(result.sampleCount,101);close(result.sampleDurationMs,121000);close(result.currentFps,100);assert(result.low1Fps<.02);
  for(let i=0;i<5900;i++)metrics.record(time+=10);
  result=metrics.snapshot();assert.equal(result.sampleCount,6000);close(result.sampleDurationMs,60000);close(result.averageFps,100);
});

test('Invalid and backward timestamps break the baseline; duplicate timestamps add no frame',()=>{
  const metrics=createFpsMetrics();assert.equal(metrics.record(NaN),false);assert.equal(metrics.record(-1),false);
  feed(metrics,[10,10]);assert.equal(metrics.record(20),false);metrics.record(30);
  assert.equal(metrics.record(25),false);assert.equal(metrics.record(40),false);metrics.record(50);
  metrics.record(Infinity);assert.equal(metrics.record(1000),false);metrics.record(1010);
  const result=metrics.snapshot();assert.equal(result.sampleCount,5);close(result.sampleDurationMs,50);close(result.currentFps,100);
});

test('Reset starts a new session with no inherited low values or timestamp baseline',()=>{
  const metrics=createFpsMetrics();feed(metrics,Array(1000).fill(20));metrics.reset();
  const result=metrics.snapshot();assert.equal(result.sampleCount,0);assert.equal(result.sampleDurationMs,0);assert.equal(result.currentFps,null);assert.equal(result.low01Fps,null);assert.equal(result.sampling,false);
  assert.equal(metrics.record(100000),false);metrics.record(100010);close(metrics.snapshot().currentFps,100);
});

console.log(JSON.stringify({success:true,checks}));
