#!/usr/bin/env python3
# Uses only the Python standard library. Runs an isolated PTY and temporary document.
import os,pty,fcntl,termios,struct,subprocess,time,select,re,tempfile,signal,json,sys
from pathlib import Path
import argparse
parser = argparse.ArgumentParser(description='Measure CLI command latency in a simulated Kitty terminal (not display FPS).')
parser.add_argument('transport', choices=['direct', 'file'], nargs='?', default='direct')
parser.add_argument('size', choices=['small', 'large'], nargs='?', default='small')
args = parser.parse_args()
ROOT = str(Path(__file__).resolve().parent)
mode, size = args.transport, args.size
rows,cols,width,windowheight=(86,240,2400,1720) if size=='large' else (30,90,900,600)
viewheight=(rows-1)*20;stride=(min(viewheight*3,4096) if size=='large' else viewheight*3)-viewheight
with tempfile.TemporaryDirectory() as d:
 doc=d+'/bench.md';open(doc,'w').write('# Benchmark\n\n'+('Text and $\\sum_{n=1}^\\infty 1/n^2 = \\pi^2/6$. 中文測試。\n\n'*400))
 m,s=pty.openpty();fcntl.ioctl(s,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,width,windowheight))
 p=subprocess.Popen(['node',ROOT+'/cli.js',doc],stdin=s,stdout=s,stderr=s,env={key:value for key,value in os.environ.items() if not key.startswith("ZELLIJ")},start_new_session=True);os.close(s)
 buf=b'';frames=[];uploads=[];answered=False;phase='start';t0=time.monotonic();directbytes=0;files=0;probes=0
 def poll(timeout=.01):
  global buf,answered,directbytes,files,probes
  if select.select([m],[],[],timeout)[0]:
   try:data=os.read(m,262144)
   except OSError:return
   now=time.monotonic();buf+=data
   if not answered and b'i=31;AAAA' in buf:
    os.write(m,f'\x1b[6;20;10t\x1b[4;{windowheight};{width}t\x1b]10;rgb:dddd/eeee/ffff\x1b\\\x1b_Gi=31;OK\x1b\\'.encode());answered=True
   while b'\x1b\\' in buf:
    end=buf.index(b'\x1b\\')+2;command=buf[:end];buf=buf[end:]
    if b't=f' in command:
     ident=re.search(rb'(?:^|,)i=(\d+)',command[command.find(b'\x1b_G')+3:]).group(1)
     answer=b'OK' if mode=='file' else b'ENOTSUP: benchmark direct mode'
     if b'a=q' in command:probes+=1
     else:files+=1;uploads.append((phase,now-t0,'file'))
     os.write(m,b'\x1b_Gi='+ident+b';'+answer+b'\x1b\\')
    if b'a=t,' in command and b't=d' in command:uploads.append((phase,now-t0,'direct'))
    if b't=d' in command or b'\x1b_Gm=' in command:directbytes+=len(command)
    match=re.search(rb'a=p,[^;]*i=(\d+)[^;]*y=(\d+)',command)
    if match:frames.append((phase,now-t0,int(match[1]),int(match[2])))
 def idle(seconds=.3):
  end=time.monotonic()+seconds
  while time.monotonic()<end:poll(.005)
 def command(name,key,timeout=6,after=.25):
  global phase
  phase=name;before=len(frames);begin=time.monotonic();os.write(m,key);end=begin+timeout
  while len(frames)==before and time.monotonic()<end:poll(.005)
  latency=(frames[-1][1]-(begin-t0))*1000 if len(frames)>before else None
  idle(after)
  return {'latency_ms':round(latency,2) if latency else None,'frames':len(frames)-before,'uploads':len([u for u in uploads if u[0]==name])}
 def stream(name,seconds,direction=1,tickrate=40):
  global phase
  phase=name;end=time.monotonic()+seconds;tick=time.monotonic()
  while time.monotonic()<end:
   if time.monotonic()>=tick:os.write(m,b'\x1b[<'+(b'65' if direction>0 else b'64')+b';10;10M');tick+=1/tickrate
   poll(.004)
  idle(.4)
  fs=[v for v in frames if v[0]==name];interval=[(b[1]-a[1])*1000 for a,b in zip(fs,fs[1:])];bound=[round((b[1]-a[1])*1000,2) for a,b in zip(fs,fs[1:]) if b[2]!=a[2]]
  return {'frames':len(fs),'median_ms':round(sorted(interval)[len(interval)//2],2),'p95_ms':round(sorted(interval)[int(len(interval)*.95)],2),'max_ms':round(max(interval),2),'boundary_ms':bound,'uploads':len([v for v in uploads if v[0]==name])}
 try:
  end=time.monotonic()+10
  while not frames and time.monotonic()<end:poll()
  if not frames:
   raise RuntimeError('Viewer did not produce an initial placement within 10 seconds')
  result={'size':size,'transport':mode,'startup_ms':round(frames[0][1]*1000,2),'startup_probe_count':probes}
  idle(.25)
  result['wheel']=stream('wheel',6)
  result['reverse']=stream('reverse',3,-1)
  result['cold_G']=command('coldG',b'G')
  result['warm_G']=command('warmG',b'G')
  result['unchanged_r']=command('unchangedr',b'r')
  result['zoom6']=command('zoom6',b'======',after=.75)
  result['reset_zoom6']=command('resetzoom',b'------',after=.3)
  result['top']=command('top',b'g')
  # Center natural scroll target immediately below first canonical boundary.
  ticks=int(stride/29.7);result['approach']=command('approach',b'\x1b[<65;10;10M'*ticks,after=.4)
  phase='oscillation'
  for n in range(24):os.write(m,b'\x1b[<'+(b'65' if n%2==0 else b'64')+b';10;10M');idle(.09)
  fs=[v for v in frames if v[0]=='oscillation'];interval=[(b[1]-a[1])*1000 for a,b in zip(fs,fs[1:])];bound=[round((b[1]-a[1])*1000,2) for a,b in zip(fs,fs[1:]) if b[2]!=a[2]]
  result['oscillation']={'frames':len(fs),'p95_ms':round(sorted(interval)[int(len(interval)*.95)],2),'max_ms':round(max(interval),2),'boundary_ms':bound,'uploads':len([u for u in uploads if u[0]=='oscillation'])}
  result['total_direct_bytes']=directbytes;result['total_file_uploads']=files;result['probes']=probes
  print(json.dumps(result,indent=2),flush=True)
 finally:
  if p.poll() is None:
   try: os.write(m,b'q')
   except OSError: pass
  end=time.monotonic()+3
  while p.poll() is None and time.monotonic()<end:poll()
  if p.poll() is None:os.killpg(p.pid,signal.SIGKILL)
  p.wait();os.close(m)
