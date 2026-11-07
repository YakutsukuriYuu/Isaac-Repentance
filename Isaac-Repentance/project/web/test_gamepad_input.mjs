import assert from 'node:assert/strict';
import {mapStick,touchToXInput,physicalToXInput,mergeXInput} from './gamepad_input.mjs';

assert.deepEqual(mapStick(0,0),[0,0]);
assert.deepEqual(mapStick(0.05,0.05),[0,0]);
assert.deepEqual(mapStick(1,0),[32767,0]);
assert.deepEqual(mapStick(0,-1),[0,-32767]);
assert.deepEqual(mapStick(Number.NaN,1),[0,0]);
const diagonal=Math.round(32767/Math.SQRT2);
assert.deepEqual(mapStick(1,1),[diagonal,diagonal]);
const half=mapStick(0.5,0);
assert.ok(half[0]>0&&half[0]<32767&&half[1]===0);

const touch=touchToXInput({active:true,sticks:{move:{x:1,y:1},shoot:{x:-1,y:0}},keys:[69,32,256]});
assert.equal(touch.connected,true);
assert.equal(touch.lx,diagonal);
assert.equal(touch.ly,-diagonal);
assert.equal(touch.rx,-32767);
assert.equal(touch.ry,0);
assert.equal(touch.buttons&0x0100,0x0100);
assert.equal(touch.buttons&0x2000,0x2000);
assert.equal(touch.buttons&0x0010,0);
assert.equal(touch.lt,255);
const menuKey=touchToXInput({active:true,sticks:{},keys:[348]});
assert.equal(menuKey.buttons,0x0010);
assert.equal(touchToXInput({active:false,sticks:{move:{x:1,y:0}},keys:[69]}).connected,false);

const button=(pressed,value=pressed?1:0)=>({pressed,value});
const physical=physicalToXInput({connected:true,axes:[0,1,0,-1],buttons:[
  button(true),button(false),button(false),button(false),
  button(false),button(true),button(false,0.5),button(false,1),
  button(false),button(true),button(false),button(false),
  button(true),button(false),button(false),button(false),
]});
assert.equal(physical.ly,-32767);
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
