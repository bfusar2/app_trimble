"""Corte DXF Local: desktop interface. Worker process keeps cancellation reliable.

Fluxo simplificado: o JSON exportado pelo painel do Trimble é aberto sozinho
(o mais recente da pasta Downloads), a pasta dos IFCs e os arquivos escolhidos
são lembrados por modelo e revisão, e o DXF é salvo ao lado do JSON.
"""
from datetime import datetime
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

HOME = Path.home()/'.corte-dxf'
SETTINGS = HOME/'settings.json'
JOB_PATTERN = 'corte-trimble*.json'   # navegadores acrescentam " (1)", " (2)"...


def match_folder(folder, models):
    """Match nested project folders only when the IFC basename is unique."""
    files={}
    for path in Path(folder).rglob('*'):
        if path.is_file() and path.suffix.lower()=='.ifc':
            files.setdefault(path.name.casefold(),[]).append(path)
    matches={};ambiguous=[]
    for item in models:
        name=Path(item['name']).name.casefold()
        if not name.endswith('.ifc'):name+='.ifc'
        candidates=files.get(name,[])
        if len(candidates)==1:matches[item['id']]=str(candidates[0])
        elif len(candidates)>1:ambiguous.append(item['name'])
    return matches,ambiguous


def downloads_folder():
    """Pasta Downloads do Windows, mesmo quando foi movida para outro disco."""
    if os.name=='nt':
        try:
            import winreg
            key_path=r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,key_path) as key:
                value,_=winreg.QueryValueEx(key,'{374DE290-123F-4565-9164-39C4925E467B}')
            folder=Path(os.path.expandvars(value))
            if folder.is_dir():return folder
        except OSError:pass
    return Path.home()/'Downloads'


def latest_job(folder):
    """Configuração mais recente exportada pelo painel, ou None."""
    try:files=[path for path in Path(folder).glob(JOB_PATTERN) if path.is_file()]
    except OSError:return None
    return max(files,key=lambda path:path.stat().st_mtime,default=None)


def load_settings(path=None):
    try:data=json.loads(Path(path or SETTINGS).read_text(encoding='utf-8'))
    except (OSError,ValueError):return {}
    return data if isinstance(data,dict) else {}


def save_settings(settings,path=None):
    path=Path(path or SETTINGS);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.tmp')
    temp.write_text(json.dumps(settings,ensure_ascii=False,indent=2),encoding='utf-8')
    temp.replace(path)


def remember_file(settings,item,path):
    """Guarda o IFC escolhido para este modelo *e esta revisão* do Trimble."""
    settings.setdefault('files',{})[str(item['id'])]={
        'path':str(path),'versionId':str(item.get('versionId') or ''),'name':item.get('name','')}


def restore_paths(models,settings):
    """Arquivos lembrados (mesmo modelo e mesma revisão) e, para o resto, a pasta lembrada.

    Retorna (paths, ambiguous, outdated): outdated lista modelos cuja revisão mudou
    desde a última escolha, para não reaproveitar um IFC antigo sem avisar.
    """
    files=settings.get('files') if isinstance(settings.get('files'),dict) else {}
    paths={};outdated=[]
    for item in models:
        saved=files.get(str(item['id']))
        if not isinstance(saved,dict) or not Path(str(saved.get('path',''))).is_file():continue
        version=str(item.get('versionId') or '')
        if version and saved.get('versionId')==version:paths[item['id']]=saved['path']
        else:outdated.append(item['name'])
    ambiguous=[]
    folder=settings.get('folder')
    missing=[item for item in models if item['id'] not in paths]
    if missing and isinstance(folder,str) and Path(folder).is_dir():
        matches,ambiguous=match_folder(folder,missing)
        paths.update(matches)
        outdated=[name for name in outdated if not any(m['name']==name and m['id'] in matches for m in missing)]
    return paths,ambiguous,outdated


def needs_confirmation(job):
    """Modelos sem as três referências mínimas: o alinhamento só passa com confirmação."""
    return [item['name'] for item in job['models'] if len(item.get('referenceObjects') or [])<3]


def default_output(job_path,now=None):
    """DXF ao lado do JSON, com data e hora, sem sobrescrever arquivos existentes."""
    now=now or datetime.now()
    base=Path(job_path).with_name(f'corte_{now:%Y%m%d_%H%M}')
    candidate=base.with_suffix('.dxf');n=2
    while any(candidate.with_name(candidate.stem+suffix).exists() for suffix in ('.dxf','_parcial.dxf')):
        candidate=base.with_name(f'{base.name}_{n}.dxf');n+=1
    return candidate


def gui():
    root=tk.Tk();root.title('Corte DXF Local');root.geometry('860x680')
    settings=load_settings()
    downloads=downloads_folder()
    newest=latest_job(downloads)
    state={'job':None,'job_path':None,'paths':{},'process':None,'output':None,'saved':None,
           'seen':newest.stat().st_mtime if newest else 0}
    messages=queue.Queue()
    cache=HOME/'cache'
    frame=ttk.Frame(root,padding=16);frame.pack(fill='both',expand=True)
    ttk.Label(frame,text='Corte DXF Local',font=('Segoe UI',18,'bold')).pack(anchor='w')
    ttk.Label(frame,text='Exporte a configuração do corte no painel do Trimble. Ela abre aqui sozinha; '
              'confira os IFCs e clique em Gerar DXF.',wraplength=810).pack(anchor='w',pady=8)
    header=ttk.Frame(frame);header.pack(fill='x')
    label=ttk.Label(frame,text='Aguardando a configuração exportada no Trimble (pasta Downloads).',wraplength=810)
    label.pack(anchor='w',pady=6)
    table=ttk.Treeview(frame,columns=('name','path'),show='headings',height=8)
    table.heading('name',text='Modelo no Trimble');table.heading('path',text='IFC no computador (duplo clique para trocar)')
    table.column('name',width=330);table.column('path',width=450);table.pack(fill='x')
    confirm=tk.BooleanVar(value=False)
    confirm_box=ttk.Frame(frame)
    check=ttk.Checkbutton(confirm_box,variable=confirm)
    check.pack(anchor='w')
    ttk.Label(confirm_box,text='Esses modelos não têm referências suficientes para o alinhamento automático. '
              'Marque somente se eles não foram movidos nem girados no visualizador. Vale para todo o lote.',
              wraplength=810).pack(anchor='w')
    actions=ttk.Frame(frame);actions.pack(fill='x',pady=10)
    log=tk.Text(frame,height=13,wrap='word');log.pack(fill='both',expand=True)
    ttk.Label(frame,text='Geometria preparada fica em '+str(cache)+' | Linhas ocultas entre objetos são mantidas.',
              wraplength=810).pack(anchor='w',pady=6)

    def write(text):log.insert('end',text+'\n');log.see('end')

    def refresh():
        table.delete(*table.get_children())
        for item in state['job']['models']:
            table.insert('','end',iid=item['id'],values=(item['name'],state['paths'].get(item['id'],'Escolha o IFC (duplo clique)')))

    def load_job(path,automatic=False):
        try:
            from runner import validate_job
            job=validate_job(json.loads(Path(path).read_text(encoding='utf-8-sig')))
        except Exception as error:
            # Arquivo ainda sendo gravado pelo navegador ou inválido: avisa sem travar.
            if automatic:write(f'Não foi possível abrir {Path(path).name}: {error}')
            else:messagebox.showerror('Não foi possível abrir',str(error))
            return
        paths,ambiguous,outdated=restore_paths(job['models'],settings)
        state.update(job=job,job_path=Path(path),paths=paths,output=default_output(path),saved=None)
        exported=datetime.fromtimestamp(Path(path).stat().st_mtime).strftime('%d/%m %H:%M')
        label.config(text=f"{job['project'].get('name','Projeto')} | {len(job['models'])} modelo(s) | "
                          f"profundidade {job['drawing']['depth']} m | {Path(path).name}, exportado em {exported}")
        refresh()
        log.delete('1.0','end')
        write(('Configuração aberta automaticamente: ' if automatic else 'Configuração aberta: ')+str(path))
        for warning in job.get('warnings',[]):
            if warning.get('code')!='INSUFFICIENT_REFERENCES':write(warning['message'])
        if outdated:write('Revisão nova no Trimble, escolha o IFC atualizado (duplo clique): '+', '.join(outdated))
        if ambiguous:write('Nomes repetidos em pastas diferentes, escolha por duplo clique: '+', '.join(ambiguous))
        missing=[item['name'] for item in job['models'] if item['id'] not in paths]
        if missing and not settings.get('folder'):write('Clique em "Escolher pasta de IFCs" para localizar os arquivos.')
        elif missing:write('Sem IFC local para: '+', '.join(missing)+'. Dê duplo clique na linha para escolher.')
        pending=needs_confirmation(job)
        confirm.set(False)
        if pending:
            check.config(text='Confirmo que usam as mesmas coordenadas da tesoura: '+', '.join(pending))
            confirm_box.pack(anchor='w',pady=10,before=actions)
        else:confirm_box.pack_forget()
        write('O DXF será salvo em: '+str(state['output']))
        open_folder.config(state='disabled')

    def open_other():
        if state['process']:return
        path=filedialog.askopenfilename(title='Configuração do corte',initialdir=str(downloads),
                                        filetypes=[('Corte Trimble','*.json')])
        if not path:return
        current=latest_job(downloads)
        state['seen']=max(state['seen'],current.stat().st_mtime if current else 0)
        load_job(path)

    def choose_folder():
        if not state['job']:return messagebox.showinfo('Configuração','Exporte a configuração no painel do Trimble primeiro.')
        folder=filedialog.askdirectory(title='Pasta dos IFCs',initialdir=settings.get('folder') or str(Path.home()))
        if not folder:return
        settings['folder']=folder;save_settings(settings)
        matches,ambiguous=match_folder(folder,state['job']['models'])
        state['paths'].update(matches)
        write(f'{len(matches)} IFC(s) encontrado(s) em {folder}.')
        if ambiguous:write('Nomes repetidos em pastas diferentes, escolha por duplo clique: '+', '.join(ambiguous))
        refresh()

    def choose_file(event=None):
        selected=table.selection()
        if not selected or state['process']:return
        item=next(model for model in state['job']['models'] if model['id']==selected[0])
        current=state['paths'].get(item['id'])
        path=filedialog.askopenfilename(title='Escolher IFC de '+item['name'],filetypes=[('IFC','*.ifc')],
                                        initialdir=str(Path(current).parent) if current else settings.get('folder'))
        if not path:return
        state['paths'][item['id']]=path
        remember_file(settings,item,path);save_settings(settings)
        refresh()

    table.bind('<Double-1>',choose_file)
    ttk.Button(header,text='Escolher pasta de IFCs',command=choose_folder).pack(side='left',padx=(0,8))
    ttk.Button(header,text='Abrir outra configuração…',command=open_other).pack(side='left')

    def finished(code,temp):
        state['process']=None;generate.config(state='normal');cancel.config(state='disabled');check.config(state='normal')
        temp.cleanup()
        if code==0 and state['saved']:
            write('\nConcluído. O relatório está ao lado do DXF.')
            open_folder.config(state='normal')
        else:write('\nProcessamento interrompido ou com falha. Consulte as mensagens acima.')

    def start():
        if state['process']:return
        if not state['job']:return messagebox.showinfo('Configuração','Exporte a configuração no painel do Trimble primeiro.')
        if not state['paths']:return messagebox.showinfo('IFCs','Escolha a pasta dos IFCs ou dê duplo clique em cada modelo.')
        missing=len(state['job']['models'])-len(state['paths'])
        if missing and not messagebox.askyesno('Arquivos ausentes',f'{missing} modelo(s) sem arquivo local. Gerar DXF parcial com os demais?'):return
        state['output']=default_output(state['job_path'])
        temp=tempfile.TemporaryDirectory(prefix='corte-dxf-')
        folder=Path(temp.name)
        (folder/'job.json').write_text(json.dumps(state['job']),encoding='utf-8')
        (folder/'map.json').write_text(json.dumps(state['paths']),encoding='utf-8')
        args=[sys.executable,'--worker'] if getattr(sys,'frozen',False) else [sys.executable,'-u',str(Path(__file__).with_name('runner.py'))]
        args += [str(folder/'job.json'),'--map',str(folder/'map.json'),'--output',str(state['output']),'--cache',str(cache)]
        if confirm.get():args+=['--ifc-coordinates']
        process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        state.update(process=process,saved=None);generate.config(state='disabled');cancel.config(state='normal');check.config(state='disabled')
        open_folder.config(state='disabled')
        write('\nPreparando os modelos. A primeira leitura pode demorar; os próximos cortes reutilizam o cache.')
        def collect():
            for line in process.stdout:messages.put(('line',line))
            messages.put(('done',(process.wait(),temp)))
        threading.Thread(target=collect,daemon=True).start()

    def stop():
        if state['process']:state['process'].terminate()

    def show_output():
        if state['saved'] and Path(state['saved']).exists():
            subprocess.Popen(f'explorer /select,"{state["saved"]}"')

    generate=ttk.Button(actions,text='Gerar DXF',command=start);generate.pack(side='left',padx=(0,8))
    cancel=ttk.Button(actions,text='Cancelar',command=stop,state='disabled');cancel.pack(side='left',padx=(0,8))
    open_folder=ttk.Button(actions,text='Mostrar DXF na pasta',command=show_output,state='disabled');open_folder.pack(side='left')

    ticks={'n':0}
    def poll():
        try:
            while True:
                kind,value=messages.get_nowait()
                if kind=='line':
                    log.insert('end',value);log.see('end')
                    if value.startswith('DXF salvo: '):state['saved']=value[len('DXF salvo: '):].strip()
                else:finished(*value)
        except queue.Empty:pass
        # A cada ~2 s, abre sozinha uma nova exportação do painel (fora durante a geração).
        ticks['n']+=1
        if ticks['n']%13==0 and not state['process']:
            current=latest_job(downloads)
            if current and current.stat().st_mtime>state['seen']:
                state['seen']=current.stat().st_mtime
                load_job(current,automatic=True)
        root.after(150,poll)

    def close():stop();root.destroy()
    if newest:load_job(newest,automatic=True)
    root.protocol('WM_DELETE_WINDOW',close);poll();root.mainloop()


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1] in ('--worker','--smoke'):
        # Windowed PyInstaller builds unset streams even when a worker is piped.
        if sys.stdout is None: sys.stdout=open(1,'w',encoding='utf-8',buffering=1,closefd=False)
        if sys.stderr is None: sys.stderr=open(2,'w',encoding='utf-8',buffering=1,closefd=False)
        mode=sys.argv.pop(1)
        if mode=='--smoke':
            try:
                import ifcopenshell, ifcopenshell.geom, numpy, shapely, ezdxf
                from geometry import prepare
                print(json.dumps({'ifcopenshell':ifcopenshell.version,'numpy':numpy.__version__,'shapely':shapely.__version__,'ezdxf':ezdxf.__version__}),flush=True)
                if len(sys.argv)>2:
                    result=prepare(sys.argv[1],sys.argv[2],lambda message:print(message,flush=True))
                    print(json.dumps({'meshes':len(result['meshes']),'cacheHit':result['cacheHit']}),flush=True)
            except Exception:
                import traceback
                traceback.print_exc();sys.exit(1)
        else:
            from runner import main
            main()
    else:gui()
