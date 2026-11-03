/** Player-owned touch placement. The editor uses inert visual copies: no game input. */
export const TOUCH_LAYOUT_KEY='isaacJ835.touchLayout.v1';
const IDS=['move','shoot','key-69','key-32','key-81','key-341','key-258','key-256','key-257','key-96'];
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const finite=(value,fallback,min,max)=>typeof value==='number'&&Number.isFinite(value)?clamp(value,min,max):fallback;
const idFor=element=>element.dataset.stick||`key-${element.dataset.key}`;

export function createTouchLayout({root,editor,onOpen=()=>{},onClose=()=>{},onError=()=>{},initialValue,onSave,listenToStorage=true}){
  if(!root||!editor)throw new TypeError('Touch layout requires controls and an editor.');
  const doc=root.ownerDocument,win=doc.defaultView,$=id=>doc.getElementById(id);
  const controller=new AbortController(),signal=controller.signal;
  const listen=(target,type,handler,options={})=>target.addEventListener(type,handler,{signal,...options});
  let saved={version:1},draft=null,opened=false,saving=false,selected='move',drag=null,oldFocus=null,oldOverflow='',inertStates=[],resizeFrame=0;
  const preview=root.cloneNode(true);preview.id='touch-layout-preview';preview.hidden=false;preview.setAttribute('aria-label','拖动以调整虚拟按键');
  $('touch-layout-stage').append(preview);
  const elements=container=>Array.from(container.querySelectorAll('[data-stick],[data-key]'));
  const disabledControls=new Set(elements(root).filter(element=>element.hidden||element.disabled).map(idFor));
  for(const container of [root,preview]){
    container.classList.add('layout-positioned');
    for(const element of elements(container))element.dataset.layoutControl=idFor(element);
  }
  for(const element of elements(preview)){element.tabIndex=0;element.setAttribute('role','button');element.classList.remove('active');}
  function dimensions(){
    const style=win.getComputedStyle(root),number=name=>parseFloat(style.getPropertyValue(name))||0;
    return {width:win.innerWidth,height:win.innerHeight,left:number('--layout-safe-left'),right:number('--layout-safe-right'),top:number('--layout-safe-top'),bottom:number('--layout-safe-bottom')};
  }
  const orientation=()=>win.innerWidth>win.innerHeight?'landscape':'portrait';
  function geometry(id,value,screen=dimensions()){
    const short=Math.min(screen.width,screen.height),stick=id==='move'||id==='shoot',menu=['key-258','key-256','key-257','key-96'].includes(id);
    const base=stick?clamp(short*.30,88,136):menu?clamp(short*.16,48,70):clamp(short*.125,40,52);
    const top=screen.top+64,bottom=screen.height-screen.bottom-(stick?30:8);
    const width=Math.min(base*value.size,screen.width-screen.left-screen.right-16,Math.max(28,bottom-top));
    const height=menu?width*.62:width;
    const minX=screen.left+8+width/2,maxX=Math.max(minX,screen.width-screen.right-8-width/2);
    const minY=top+height/2,maxY=Math.max(minY,bottom-height/2);
    return {width,height,minX,maxX,minY,maxY,x:minX+(maxX-minX)*value.x,y:minY+(maxY-minY)*value.y};
  }
  function defaults(){
    const screen=dimensions(),short=Math.min(screen.width,screen.height),stick=clamp(short*.30,88,136),button=clamp(short*.125,40,52),menu=clamp(short*.16,48,70);
    const bottom=screen.height-screen.bottom,edge=screen.width-screen.right,stickBottom=screen.width<360?68:44;
    const positions={move:[screen.left+22+stick/2,bottom-stickBottom-stick/2],shoot:[edge-22-stick/2,bottom-stickBottom-stick/2],
      'key-341':[edge-20-button*3.5-27,bottom-74-stick-button/2],
      'key-69':[edge-20-button*2.5-18,bottom-74-stick-button/2],
      'key-32':[edge-20-button*1.5-9,bottom-74-stick-button/2],
      'key-81':[edge-20-button*.5,bottom-74-stick-button/2],
      'key-258':[screen.width/2-menu-8,bottom-16-menu*.31],
      'key-256':[screen.width/2,bottom-16-menu*.31],
      'key-257':[screen.width/2+menu+8,bottom-16-menu*.31],
      'key-96':[edge-20-menu/2,screen.top+76+menu*.31]};
    return Object.fromEntries(IDS.map(id=>{
      const value={x:.5,y:.5,size:1,opacity:id==='move'||id==='shoot'?.7:.85},g=geometry(id,value,screen),[x,y]=positions[id];
      value.x=clamp((x-g.minX)/(g.maxX-g.minX||1),0,1);value.y=clamp((y-g.minY)/(g.maxY-g.minY||1),0,1);return [id,value];
    }));
  }
  function sanitize(value){
    const result={version:1};if(!value||value.version!==1)return result;
    for(const direction of ['portrait','landscape']){
      const profile=value[direction];if(!profile||typeof profile!=='object')continue;
      result[direction]={};
      for(const id of IDS){const item=profile[id];if(!item||typeof item!=='object')continue;
        result[direction][id]={x:finite(item.x,.5,0,1),y:finite(item.y,.5,0,1),size:finite(item.size,1,.6,1.8),opacity:finite(item.opacity,.7,.2,1)};
      }
    }return result;
  }
  try{saved=sanitize(initialValue===undefined?JSON.parse(win.localStorage.getItem(TOUCH_LAYOUT_KEY)||'null'):initialValue);}catch{/* Unavailable or invalid storage uses the default layout. */}
  function profile(settings){return {...defaults(),...(settings[orientation()]||{})};}
  function applyTo(container,values){
    const screen=dimensions();
    for(const element of elements(container)){
      const id=idFor(element),value=values[id],g=geometry(id,value,screen);
      element.hidden=disabledControls.has(id);if(element.matches('button'))element.disabled=element.hidden;
      Object.assign(element.style,{left:`${g.x}px`,top:`${g.y}px`,width:`${g.width}px`,height:`${g.height}px`,opacity:String(value.opacity),fontSize:`${clamp(11*value.size,9,18)}px`});
      element.classList.toggle('layout-selected',container===preview&&id===selected);
      if(container===preview)element.setAttribute('aria-pressed',String(id===selected));
    }
  }
  function apply(){applyTo(root,profile(saved));}
  function current(){const key=orientation();return draft[key]=profile(draft);}
  function render(){
    if(!opened)return;
    const values=current(),value=values[selected];applyTo(preview,values);
    $('touch-layout-orientation').textContent=orientation()==='portrait'?'竖屏布局 · 独立保存':'横屏布局 · 独立保存';
    $('touch-layout-control').value=selected;
    for(const key of ['size','opacity','x','y']){
      const number=Math.round(value[key]*100);$(`touch-layout-${key}`).value=String(number);$(`touch-layout-${key}-value`).value=`${number}%`;
    }
  }
  function select(id){if(!IDS.includes(id)||disabledControls.has(id))return;selected=id;render();}
  /** Hide optional controls in both the game and editor without discarding their layout. */
  function setControlEnabled(id,enabled){
    if(!IDS.includes(id))return;
    if(enabled)disabledControls.delete(id);else disabledControls.add(id);
    for(const option of $('touch-layout-control').options)if(option.value===id){option.hidden=!enabled;option.disabled=!enabled;}
    if(disabledControls.has(selected)){releaseDrag();selected=IDS.find(value=>!disabledControls.has(value))||'move';}
    apply();applyTo(preview,profile(opened?draft:saved));render();
  }
  function update(key,value){if(!opened)return;current()[selected][key]=value;render();$('touch-layout-status').textContent='';}
  function releaseDrag(){
    if(!drag)return;const previous=drag;drag=null;
    if(previous.element.hasPointerCapture?.(previous.pointer))previous.element.releasePointerCapture(previous.pointer);
  }
  function open(){
    if(opened)return;onOpen();opened=true;draft=structuredClone(saved);oldFocus=doc.activeElement;
    oldOverflow=doc.body.style.overflow;doc.body.style.overflow='hidden';
    inertStates=Array.from(editor.parentElement.children).filter(element=>element!==editor&&['MAIN','SECTION','DIV','FOOTER','HEADER'].includes(element.tagName)).map(element=>({element,inert:element.inert}));
    for(const state of inertStates)state.element.inert=true;
    editor.hidden=false;$('touch-layout-panel').hidden=false;$('touch-layout-panel-toggle').setAttribute('aria-expanded','true');$('touch-layout-panel-toggle').textContent='收起面板';
    $('touch-layout-status').textContent='';render();$('touch-layout-control').focus({preventScroll:true});
  }
  function close(){
    if(!opened||saving)return;releaseDrag();opened=false;draft=null;editor.hidden=true;doc.body.style.overflow=oldOverflow;
    for(const state of inertStates)state.element.inert=state.inert;inertStates=[];
    apply();onClose();if(oldFocus?.isConnected)oldFocus.focus({preventScroll:true});
  }
  listen($('touch-layout-save'),'click',async()=>{
    if(!opened||saving)return;
    const value=structuredClone(draft);saving=true;$('touch-layout-save').disabled=true;$('touch-layout-cancel').disabled=true;
    try{
      if(onSave)await onSave(value);else win.localStorage.setItem(TOUCH_LAYOUT_KEY,JSON.stringify(value));
      saved=value;saving=false;close();
    }catch(error){$('touch-layout-status').textContent='无法保存设置，请保留当前页面并重试。';onError(error);}
    finally{saving=false;$('touch-layout-save').disabled=false;$('touch-layout-cancel').disabled=false;}
  });
  listen($('touch-layout-cancel'),'click',close);
  listen($('touch-layout-reset'),'click',()=>{if(opened){releaseDrag();draft[orientation()]=defaults();render();$('touch-layout-status').textContent='已恢复当前方向默认布局，保存后生效。';}});
  listen($('touch-layout-control'),'change',event=>select(event.target.value));
  for(const key of ['size','opacity','x','y'])listen($(`touch-layout-${key}`),'input',event=>update(key,Number(event.target.value)/100));
  listen($('touch-layout-panel-toggle'),'click',()=>{
    const hidden=!$('touch-layout-panel').hidden;$('touch-layout-panel').hidden=hidden;$('touch-layout-panel-toggle').setAttribute('aria-expanded',String(!hidden));$('touch-layout-panel-toggle').textContent=hidden?'展开面板':'收起面板';
  });
  for(const element of elements(preview)){
    listen(element,'pointerdown',event=>{
      if(!opened||drag||disabledControls.has(idFor(element))||(event.pointerType==='mouse'&&event.button!==0))return;
      event.preventDefault();select(idFor(element));element.focus({preventScroll:true});
      const g=geometry(selected,current()[selected]);drag={element,pointer:event.pointerId,offsetX:event.clientX-g.x,offsetY:event.clientY-g.y};element.setPointerCapture(event.pointerId);
    },{passive:false});
    listen(element,'pointermove',event=>{
      if(!drag||drag.pointer!==event.pointerId)return;event.preventDefault();
      const value=current()[selected],g=geometry(selected,value);
      value.x=clamp((event.clientX-drag.offsetX-g.minX)/(g.maxX-g.minX||1),0,1);value.y=clamp((event.clientY-drag.offsetY-g.minY)/(g.maxY-g.minY||1),0,1);render();
    },{passive:false});
    for(const type of ['pointerup','pointercancel','lostpointercapture'])listen(element,type,event=>{if(drag?.pointer===event.pointerId)releaseDrag();});
    listen(element,'contextmenu',event=>event.preventDefault());
    listen(element,'focus',()=>{if(opened)select(idFor(element));});
  }
  listen(win,'keydown',event=>{
    if(!opened)return;
    if(event.code==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
    if(event.key==='Tab'){
      const focusable=Array.from(editor.querySelectorAll('button,select,input,[tabindex="0"]')).filter(element=>!element.disabled&&element.getClientRects().length);
      const index=focusable.indexOf(doc.activeElement),next=(index+(event.shiftKey?-1:1)+focusable.length)%focusable.length;
      event.preventDefault();focusable[next]?.focus({preventScroll:true});return;
    }
    if(!doc.activeElement?.dataset.layoutControl||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.code))return;
    event.preventDefault();event.stopImmediatePropagation();const value=current()[selected],amount=event.shiftKey?.05:.01;
    const key=['ArrowLeft','ArrowRight'].includes(event.code)?'x':'y',sign=['ArrowLeft','ArrowUp'].includes(event.code)?-1:1;
    update(key,clamp(value[key]+sign*amount,0,1));
  },{capture:true});
  function resize(){releaseDrag();win.cancelAnimationFrame(resizeFrame);resizeFrame=win.requestAnimationFrame(()=>{apply();render();});}
  listen(win,'resize',resize);listen(win,'orientationchange',resize);listen(win,'blur',releaseDrag);
  if(listenToStorage)listen(win,'storage',event=>{if(event.key!==TOUCH_LAYOUT_KEY||opened)return;try{saved=sanitize(JSON.parse(event.newValue));apply();}catch{}});
  apply();
  return {open,close,apply,setControlEnabled,isOpen:()=>opened,destroy(){close();win.cancelAnimationFrame(resizeFrame);controller.abort();preview.remove();}};
}
