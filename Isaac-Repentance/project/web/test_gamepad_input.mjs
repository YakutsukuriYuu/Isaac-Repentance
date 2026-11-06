import assert from 'node:assert/strict';
import {axisToI16,touchToXInput,physicalToXInput,mergeXInput} from './gamepad_input.mjs';

assert.equal(axisToI16(0),0);
assert.equal(axisToI16(0.1),0);
assert.equal(axisToI16(1),32767);
assert.equal(axisToI16(-1),-32767);
assert.ok(axisToI16(0.5)>0&&axisToI16(0.5)<32767);
assert.equal(axisToI16(Number.NaN),0);

const touch=touchToXInput({active:true,sticks:{move:{x:1,y:1},shoot:{x:-1,y:0}},keys:[69,32,256]});
assert.equal(touch.connected,true);
assert.equal(touch.lx,32767);
assert.equal(touch.ly,-32767);
assert.equal(touch.rx,-32767);
assert.equal(touch.ry,0);
assert.equal(touch.buttons&0x0100,0x0100);
assert.equal(touch.buttons&0x0010,0x0010);
assert.equal(touch.lt,255);
assert.equal(touchToXInput({active:false,sticks:{move:{x:1,y:0}},keys:[69]}).connected,false);

const button=(pressed,value=pressed?1:0)=>({pressed,value});
const physical=physicalToXInput({connected:true,axes:[0,1,0.2,-1],buttons:[
  button(true),button(false),button(false),button(false),
  button(false),button(true),button(false,0.5),button(false,1),
  button(false),button(true),button(false),button(false),
  button(true),button(false),button(false),button(false),
]});
assert.equal(physical.ly<0,true);
assert.equal(physical.ry,32767);
assert.equal(physical.buttons&0x1000,0x1000);
assert.equal(physical.buttons&0x0200,0x0200);
assert.equal(physical.buttons&0x0010,0x0010);
assert.equal(physical.buttons&0x0001,0x0001);
assert.equal(physical.rt,255);
assert.equal(physical.lt,128);

const merged=mergeXInput(
  {connected:true,buttons:0x0100,lt:0,rt:255,lx:1000,ly:0,rx:0,ry:0},
  {connected:true,buttons:0x1000,lt:200,rt:0,lx:-5000,ly:20,rx:0,ry:0},
);
assert.equal(merged.buttons,0x1100);
assert.equal(merged.lt,200);
assert.equal(merged.rt,255);
assert.equal(merged.lx,-5000);
assert.equal(merged.ly,20);
assert.equal(mergeXInput({connected:false},{connected:true,buttons:1}).buttons,1);

console.log('gamepad input: PASS');
