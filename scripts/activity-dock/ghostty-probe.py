#!/usr/bin/env python3
"""Isolated real-TTY feasibility probe; no agent, credentials or model calls."""
import argparse,base64,json,os,re,select,struct,termios,time,tty,zlib
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--frames',required=True);p.add_argument('--out',required=True);p.add_argument('--hold',type=float,default=3);p.add_argument('--theme',default='dark');a=p.parse_args()
out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
fd=os.open('/dev/tty',os.O_RDWR);old=termios.tcgetattr(fd);tty.setraw(fd)
E='\x1b';G=E+'_G';ST=E+'\\';image_id=129001
def write(s):os.write(fd,s.encode())
def collect(seconds):
 end=time.monotonic()+seconds;b=b''
 while time.monotonic()<end:
  if select.select([fd],[],[],min(.05,max(0,end-time.monotonic())))[0]:b+=os.read(fd,65536)
 return b
def delete():return f'{G}a=d,d=I,i={image_id},q=2{ST}'
report={'terminal':os.environ.get('TERM_PROGRAM'),'version':os.environ.get('TERM_PROGRAM_VERSION'),'events':[]}
try:
 write(E+'[?1049h'+E+'[?25l'+E+'[2J')
 write(f'{G}a=q,i={image_id},s=1,v=1,f=32;AAAAAA=={ST}'+E+'[16t'+E+'[14t')
 response=collect(1);report['probe']=repr(response);cell=re.search(rb'\x1b\[6;(\d+);(\d+)t',response)
 rows,cols,hp,wp=struct.unpack('HHHH',__import__('fcntl').ioctl(fd,termios.TIOCGWINSZ,b'\0'*8))
 if not cell:
  pixels=re.search(rb'\x1b\[4;(\d+);(\d+)t',response)
  ch,cw=(int(pixels[1])//rows,int(pixels[2])//cols) if pixels else (0,0)
 else:ch,cw=map(int,cell.groups())
 report.update(rows=rows,cols=cols,cell=[cw,ch],ioctl_pixels=[wp,hp])
 if b'OK' not in response or min(ch,cw)<=0:raise RuntimeError('graphics query/cell-size negotiation failed')
 size=min(ch,cw*3);report['image_size']=[size,size];data=json.loads(Path(a.frames).read_text())
 draft='draft 中文输入保护';row=rows-6
 write(f'{E}[{row+2};3H┌'+('─'*(cols-6))+'┐'+f'{E}[{row+3};3H│ {draft}'+f'{E}[{row+4};3H└'+('─'*(cols-6))+'┘')
 def image(name,index,color):
  alpha=zlib.decompress(base64.b64decode(data['animations'][name]['frames'][index]));rgba=bytearray()
  for y in range(size):
   for x in range(size):rgba.extend((*color,alpha[min(127,int((y+.5)*128/size))*128+min(127,int((x+.5)*128/size))]))
  return f'{E}7{E}[{row};3H'+delete()+f'{G}a=T,f=32,s={size},v={size},i={image_id},C=1,q=2;'+base64.b64encode(rgba).decode()+ST+f'{E}8'
 for name in ['official','wag','sway','twist']:
  Path(out/'phase').write_text(name);anim=data['animations'][name];period=anim['periodMs']/1000;start=time.monotonic();last=-1;indices=[]
  write(delete()+f'{E}[{row};1H'+E+'[2K'+f'{E}[{row};6H{name} 正在处理…'+f'{E}[{row+3};{5+len(draft)}H')
  while time.monotonic()-start<period+.15:
   idx=int((time.monotonic()-start)%period/period*len(anim['frames']))
   if idx!=last:write(image(name,idx,(125,161,222) if a.theme=='dark' else (54,95,157)));indices.append(idx);last=idx
   time.sleep(.005)
  report['events'].append({'animation':name,'indices':indices,'elapsed':time.monotonic()-start})
  Path(out/'phase').write_text(name);Path(out/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));collect(a.hold)
 write(delete()+f'{E}[{row};1H'+E+'[2K'+f'{E}[{row};3H等待你的选择')
 Path(out/'phase').write_text('hidden');collect(a.hold)
 write(E+'[16t');report['resize_probe']=repr(collect(.3));report['resize_input_bytes']=repr(collect(.2))
 write(f'{E}[{row};1H'+E+'[2K'+image('twist',0,(54,95,157))+f'{E}[{row};6Hlight/static'+f'{E}[{row+3};8H')
 Path(out/'phase').write_text('static');collect(a.hold)
 write(delete()+f'{E}[{row};1H'+E+'[2K'+f'{E}[{row};3H正在处理…（文字降级）')
 Path(out/'phase').write_text('fallback');collect(a.hold)
 write(E+'[6n');report['cursor_after_image']=repr(collect(.3));report['draft_expected']=draft
 report['complete']=True
except Exception as ex:report['error']=str(ex)
finally:
 write(delete()+E+'[?25h'+E+'[?1049l');termios.tcsetattr(fd,termios.TCSANOW,old);os.close(fd);Path(out/'report.json').write_text(json.dumps(report,indent=2,ensure_ascii=False));Path(out/'phase').write_text('done')
