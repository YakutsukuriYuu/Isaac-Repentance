/** Statistics for timestamps supplied by the game's native Present boundary.
 * No browser animation timer or UI refresh frequency is used as a frame source.
 */
export const FPS_WINDOW_MS=60000;
export const FPS_CURRENT_WINDOW_MS=1000;
export const FPS_MAX_SAMPLES=7200;

export function createFpsMetrics(){
  const intervals=new Float64Array(FPS_MAX_SAMPLES);
  let first=0,count=0,duration=0,previous=null;

  function removeFirst(){
    duration-=intervals[first];
    first=(first+1)%FPS_MAX_SAMPLES;
    count--;
  }
  function breakSampling(){previous=null;}
  function reset(){first=0;count=0;duration=0;previous=null;}
  /** Return true only when a complete eligible frame interval was recorded.
   * Call with eligible=false at pauses/loading, or breakSampling at host pauses.
   * The first subsequent eligible present establishes a fresh time baseline.
   */
  function record(timestamp,eligible=true){
    if(!eligible||!Number.isFinite(timestamp)||timestamp<0){breakSampling();return false;}
    if(previous===null){previous=timestamp;return false;}
    const elapsed=timestamp-previous;
    if(elapsed===0)return false;
    if(elapsed<0||!Number.isFinite(elapsed)){breakSampling();return false;}
    previous=timestamp;
    if(count===FPS_MAX_SAMPLES)removeFirst();
    intervals[(first+count)%FPS_MAX_SAMPLES]=elapsed;
    count++;
    duration+=elapsed;
    // Keep whole intervals: the boundary frame may cross the 60-second edge.
    // In particular, a genuine long frame must survive even if it alone takes
    // longer than the entire window. Pauses are excluded by the caller, not by
    // an arbitrary frame-time cutoff that would hide stutters.
    while(count>1&&duration-intervals[first]>=FPS_WINDOW_MS)removeFirst();
    return true;
  }
  function snapshot({detailed=true}={}){
    let currentDurationMs=0,currentSampleCount=0;
    for(let i=count-1;i>=0&&currentDurationMs<FPS_CURRENT_WINDOW_MS;i--){
      currentDurationMs+=intervals[(first+i)%FPS_MAX_SAMPLES];
      currentSampleCount++;
    }
    // The default/simple overlay needs only sums; avoid allocating and sorting
    // a minute of frame samples for low-percentile values that are not visible.
    const slowest=detailed&&count?Array.from({length:count},(_,i)=>intervals[(first+i)%FPS_MAX_SAMPLES]).sort((a,b)=>b-a):null;
    function low(fraction,minimum){
      if(!slowest||count<minimum)return null;
      const length=Math.ceil(count*fraction);
      let sum=0;for(let i=0;i<length;i++)sum+=slowest[i];
      return 1000*length/sum;
    }
    return {
      currentFps:currentSampleCount?1000*currentSampleCount/currentDurationMs:null,
      averageFps:count?1000*count/duration:null,
      low1Fps:low(.01,100),
      low01Fps:low(.001,1000),
      frameTimeMs:count?duration/count:null,
      sampleCount:count,
      sampleDurationMs:duration,
      currentSampleCount,
      currentDurationMs,
      sampling:previous!==null,
    };
  }
  return {record,breakSampling,reset,snapshot};
}
