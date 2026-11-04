/** Digital eight-way sticks, matching Isaac's keyboard movement and firing. */
export function stickDirections(x, y, kind='move', deadzone=0.2) {
  if(!Number.isFinite(x)||!Number.isFinite(y)||Math.hypot(x,y)<deadzone)return [];
  const map=kind==='shoot'?{left:263,right:262,up:265,down:264}:{left:65,right:68,up:87,down:83};
  const ratio=Math.tan(Math.PI/8), output=[];
  if(Math.abs(x)>=Math.abs(y)*ratio)output.push(x<0?map.left:map.right);
  if(Math.abs(y)>=Math.abs(x)*ratio)output.push(y<0?map.up:map.down);
  return output;
}

/**
 * onKeys(source, codes) supplies an entire independent input source each time.
 * Merge these sources with physical keyboard keys; do not replace keyboard state.
 */
export function createTouchControls({root,onKeys}) {
  if(!root||typeof onKeys!=='function')throw new TypeError('Touch controls need a root and onKeys callback.');
  const doc=root.ownerDocument, win=doc.defaultView;
  const controller=new AbortController(), signal=controller.signal;
  const states=[];
  let enabled=false,paintRequest=0;
  const listen=(target,type,callback)=>target.addEventListener(type,callback,{signal,passive:false});
  function emit(state,codes){
    const next=codes.join(',');
    if(state.last===next)return;
    state.last=next;
    onKeys(state.source,codes);
  }
  // Input is delivered immediately. Only the thumb's visual transform waits
  // for the next display callback, so high-rate touch samples do not cause a
  // layout read and DOM write for every event on 120/240-Hz touch panels.
  function queueThumb(state,transform){
    if(transform===state.paintedTransform&&state.pendingTransform===null)return;
    state.pendingTransform=transform;
    if(paintRequest)return;
    paintRequest=win.requestAnimationFrame(()=>{
      paintRequest=0;
      for(const item of states){
        const next=item.pendingTransform;item.pendingTransform=null;
        if(next===null||!item.thumb||item.pointer===null||!enabled)continue;
        if(next!==item.paintedTransform){item.thumb.style.transform=next;item.paintedTransform=next;}
      }
    });
  }
  function release(state){
    const id=state.pointer;state.pointer=null;state.rect=null;state.pendingTransform=null;
    state.element.classList.remove('active');
    if(state.thumb&&state.paintedTransform!=='translate(0px, 0px)'){
      state.thumb.style.transform='translate(0px, 0px)';state.paintedTransform='translate(0px, 0px)';
    }
    emit(state,[]);
    if(id!==null&&state.element.hasPointerCapture?.(id)){
      try{state.element.releasePointerCapture(id);}catch{/* The browser may already have cancelled the pointer. */}
    }
  }
  function clear(){
    if(paintRequest){win.cancelAnimationFrame(paintRequest);paintRequest=0;}
    for(const state of states)release(state);
  }
  for(const element of root.querySelectorAll('[data-stick]')){
    const state={element,source:`touch:stick:${element.dataset.stick}`,pointer:null,last:'',thumb:element.querySelector('.stick-thumb'),rect:null,pendingTransform:null,paintedTransform:null};
    states.push(state);
    function move(event){
      const rect=state.rect||(state.rect=element.getBoundingClientRect()),radius=Math.min(rect.width,rect.height)/2;
      if(!radius){release(state);return;}
      const x=(event.clientX-rect.left-rect.width/2)/radius;
      const y=(event.clientY-rect.top-rect.height/2)/radius;
      const distance=Math.hypot(x,y),scale=distance>1?1/distance:1;
      if(state.thumb)queueThumb(state,`translate(${(x*scale*radius*.53).toFixed(2)}px, ${(y*scale*radius*.53).toFixed(2)}px)`);
      emit(state,stickDirections(x,y,element.dataset.stick));
    }
    listen(element,'pointerdown',event=>{
      if(!enabled||state.pointer!==null||(event.pointerType==='mouse'&&event.button!==0))return;
      event.preventDefault();state.rect=element.getBoundingClientRect();state.pointer=event.pointerId;
      try{element.setPointerCapture(event.pointerId);}catch{release(state);return;}
      element.classList.add('active');move(event);
    });
    listen(element,'pointermove',event=>{
      if(state.pointer!==event.pointerId)return;
      event.preventDefault();move(event);
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(element,type,event=>{
      if(state.pointer===event.pointerId){event.preventDefault();release(state);}
    });
    listen(element,'contextmenu',event=>event.preventDefault());
  }
  let index=0;
  for(const element of root.querySelectorAll('[data-key]')){
    const key=Number(element.dataset.key);
    if(!Number.isInteger(key)||key<0||key>348)continue;
    const state={element,source:`touch:button:${key}:${index++}`,pointer:null,last:''};states.push(state);
    listen(element,'pointerdown',event=>{
      if(!enabled||element.disabled||state.pointer!==null||(event.pointerType==='mouse'&&event.button!==0))return;
      event.preventDefault();state.pointer=event.pointerId;
      try{element.setPointerCapture(event.pointerId);}catch{release(state);return;}
      element.classList.add('active');emit(state,[key]);
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(element,type,event=>{
      if(state.pointer===event.pointerId){event.preventDefault();release(state);}
    });
    listen(element,'contextmenu',event=>event.preventDefault());
  }
  listen(win,'blur',clear);
  listen(win,'orientationchange',clear);
  listen(win,'resize',clear);
  if(win.visualViewport){listen(win.visualViewport,'resize',clear);listen(win.visualViewport,'scroll',clear);}
  listen(doc,'visibilitychange',()=>{if(doc.hidden)clear();});
  // Player layout changes can move a stick without changing its size. Observe
  // only the control elements, not their animated thumbs, to invalidate a held
  // gesture without adding an observer callback for every painted frame.
  const byElement=new Map(states.map(state=>[state.element,state]));
  const geometryObserver=typeof win.MutationObserver==='function'?new win.MutationObserver(records=>{
    for(const record of records){
      if(record.target===root){clear();continue;}
      const state=byElement.get(record.target);
      if(state)release(state);
    }
  }):null;
  geometryObserver?.observe(root,{attributes:true,attributeFilter:['style','hidden']});
  for(const state of states)geometryObserver?.observe(state.element,{attributes:true,attributeFilter:['style','hidden','disabled']});
  function setEnabled(value){enabled=!!value;root.hidden=!enabled;if(!enabled)clear();}
  setEnabled(false);
  return {setEnabled,clear,destroy(){geometryObserver?.disconnect();clear();enabled=false;root.hidden=true;controller.abort();}};
}
