/** XInput state shared by the on-screen controls and a physical gamepad.
 * Axes are signed XInput units. Y is positive upward, unlike a touch point.
 */

const BUTTON={
  UP:0x0001,DOWN:0x0002,LEFT:0x0004,RIGHT:0x0008,
  START:0x0010,BACK:0x0020,L3:0x0040,R3:0x0080,
  LB:0x0100,RB:0x0200,
  A:0x1000,B:0x2000,X:0x4000,Y:0x8000,
};

/** The game's default controller rows: bomb, active, card, drop, pause, map. */
const TOUCH_KEYS={
  69:{bits:BUTTON.LB},
  32:{lt:255},
  81:{bits:BUTTON.RB},
  341:{rt:255},
  345:{rt:255},
  258:{bits:BUTTON.BACK},
  256:{bits:BUTTON.START},
  257:{bits:BUTTON.A},
};

function toI16(value){return Math.max(-32768,Math.min(32767,Math.round(value*32767)))||0;}

/** One deadzone for the whole stick, then scale so every direction reaches the rim together. */
export function mapStick(x,y,deadzone=0.12){
  if(!Number.isFinite(x)||!Number.isFinite(y))return [0,0];
  let magnitude=Math.hypot(x,y);
  if(magnitude<=deadzone||magnitude===0)return [0,0];
  if(magnitude>1){x/=magnitude;y/=magnitude;magnitude=1;}
  const scaled=(magnitude-deadzone)/(1-deadzone);
  const gain=scaled/magnitude;
  return [toI16(x*gain),toI16(y*gain)];
}

function blank(){return {connected:false,buttons:0,lt:0,rt:0,lx:0,ly:0,rx:0,ry:0};}

export function touchToXInput(touch){
  const out=blank();
  if(!touch?.active)return out;
  out.connected=true;
  const move=touch.sticks?.move||{};
  const shoot=touch.sticks?.shoot||{};
  [out.lx,out.ly]=mapStick(move.x||0,-(move.y||0));
  [out.rx,out.ry]=mapStick(shoot.x||0,-(shoot.y||0));
  for(const key of touch.keys||[]){
    const mapped=TOUCH_KEYS[key];
    if(!mapped)continue;
    out.buttons|=mapped.bits||0;
    if(mapped.lt)out.lt=Math.max(out.lt,mapped.lt);
    if(mapped.rt)out.rt=Math.max(out.rt,mapped.rt);
  }
  return out;
}

export function physicalToXInput(pad){
  const out=blank();
  if(!pad?.connected)return out;
  out.connected=true;
  const axes=pad.axes||[];
  [out.lx,out.ly]=mapStick(axes[0]||0,-(axes[1]||0),0.15);
  [out.rx,out.ry]=mapStick(axes[2]||0,-(axes[3]||0),0.15);
  const buttons=pad.buttons||[];
  const down=index=>!!buttons[index]&&(buttons[index].pressed||buttons[index].value>0.5);
  const value=index=>buttons[index]?Math.round(Math.max(0,Math.min(1,buttons[index].value||0))*255):0;
  if(down(0))out.buttons|=BUTTON.A;
  if(down(1))out.buttons|=BUTTON.B;
  if(down(2))out.buttons|=BUTTON.X;
  if(down(3))out.buttons|=BUTTON.Y;
  if(down(4))out.buttons|=BUTTON.LB;
  if(down(5))out.buttons|=BUTTON.RB;
  out.lt=value(6);
  out.rt=value(7);
  if(down(8))out.buttons|=BUTTON.BACK;
  if(down(9))out.buttons|=BUTTON.START;
  if(down(10))out.buttons|=BUTTON.L3;
  if(down(11))out.buttons|=BUTTON.R3;
  if(down(12))out.buttons|=BUTTON.UP;
  if(down(13))out.buttons|=BUTTON.DOWN;
  if(down(14))out.buttons|=BUTTON.LEFT;
  if(down(15))out.buttons|=BUTTON.RIGHT;
  return out;
}

export function mergeXInput(first,second){
  if(!first?.connected)return second;
  if(!second?.connected)return first;
  const pick=(left,right)=>Math.abs(left)>=Math.abs(right)?left:right;
  return {
    connected:true,
    buttons:(first.buttons|second.buttons)>>>0,
    lt:Math.max(first.lt,second.lt),
    rt:Math.max(first.rt,second.rt),
    lx:pick(first.lx,second.lx),
    ly:pick(first.ly,second.ly),
    rx:pick(first.rx,second.rx),
    ry:pick(first.ry,second.ry),
  };
}

export function createGamepadSource(readPads=()=>navigator.getGamepads?.()||[]){
  let touch={active:false,sticks:{},keys:[]};
  function setTouch(next){touch=next||{active:false,sticks:{},keys:[]};}
  function snapshot(){
    let physical=blank();
    for(const pad of readPads()||[]){
      if(!pad?.connected)continue;
      physical=physicalToXInput(pad);
      break;
    }
    return mergeXInput(touchToXInput(touch),physical);
  }
  function publish(module){if(module)module.isaacGamepad=snapshot();}
  return {setTouch,snapshot,publish};
}
