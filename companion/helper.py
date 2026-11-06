"""Corte DXF Local: desktop interface. Worker process keeps cancellation reliable."""
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


def gui():
    root=tk.Tk();root.title('Corte DXF Local');root.geometry('840x650')
    state={'job':None,'paths':{},'process':None}
    messages=queue.Queue()
    cache=Path.home()/'.corte-dxf'/'cache'
    frame=ttk.Frame(root,padding=16);frame.pack(fill='both',expand=True)
    ttk.Label(frame,text='Corte DXF Local',font=('Segoe UI',18,'bold')).pack(anchor='w')
    ttk.Label(frame,text='1. Abra a configuração exportada no Trimble.  2. Escolha os IFCs.  3. Gere o DXF.',wraplength=790).pack(anchor='w',pady=8)
    header=ttk.Frame(frame);header.pack(fill='x')
    label=ttk.Label(frame,text='Nenhuma configuração aberta.');label.pack(anchor='w',pady=6)
    table=ttk.Treeview(frame,columns=('name','path'),show='headings',height=8)
    table.heading('name',text='Modelo no Trimble');table.heading('path',text='IFC no computador')
    table.column('name',width=320);table.column('path',width=440);table.pack(fill='x')
    def refresh():
        table.delete(*table.get_children())
        for item in state['job']['models']:
            table.insert('', 'end', iid=item['id'],values=(item['name'],state['paths'].get(item['id'],'Escolha o IFC (duplo clique)')))
    def open_job():
        path=filedialog.askopenfilename(title='Configuração do corte',filetypes=[('Corte Trimble','*.json')])
        if not path:return
        try:
            from runner import validate_job
            job=validate_job(json.loads(Path(path).read_text(encoding='utf-8-sig')))
            state.update(job=job,paths={})
            label.config(text=f"{job['project'].get('name','Projeto')} | {len(job['models'])} modelo(s) | profundidade {job['drawing']['depth']} m")
            refresh()
            log.delete('1.0','end')
            log.insert('end','Escolha a mesma revisão dos IFCs usada no Trimble. O cache local será verificado pelo conteúdo.\n')
            for warning in job.get('warnings',[]):log.insert('end',warning['message']+'\n')
        except Exception as error:messagebox.showerror('Não foi possível abrir',str(error))
    def choose_folder():
        if not state['job']:return messagebox.showinfo('Configuração','Abra a configuração do Trimble primeiro.')
        folder=filedialog.askdirectory(title='Pasta dos IFCs')
        if not folder:return
        matches,ambiguous=match_folder(folder,state['job']['models'])
        state['paths'].update(matches)
        if ambiguous:log.insert('end','Nomes repetidos em pastas diferentes: escolha o arquivo por duplo clique. '+', '.join(ambiguous)+'\n')
        refresh()
    def choose_file(event=None):
        selected=table.selection()
        if not selected or state['process']:return
        path=filedialog.askopenfilename(title='Escolher IFC correspondente',filetypes=[('IFC','*.ifc')])
        if path:state['paths'][selected[0]]=path;refresh()
    table.bind('<Double-1>',choose_file)
    ttk.Button(header,text='Abrir configuração do Trimble',command=open_job).pack(side='left',padx=(0,8))
    ttk.Button(header,text='Escolher pasta de IFCs',command=choose_folder).pack(side='left')
    confirm=tk.BooleanVar(value=False)
    check=ttk.Checkbutton(frame,text='Confirmo que os IFCs usam as mesmas coordenadas da tesoura (dispensa alinhamento automático)',variable=confirm)
    check.pack(anchor='w',pady=10)
    ttk.Label(frame,text='Use essa confirmação somente após conferir as coordenadas. Modelos com um único objeto podem exigir essa conferência.',wraplength=790).pack(anchor='w')
    actions=ttk.Frame(frame);actions.pack(fill='x',pady=10)
    log=tk.Text(frame,height=13,wrap='word');log.pack(fill='both',expand=True)
    ttk.Label(frame,text='Geometria preparada fica em '+str(cache)+' | Linhas ocultas entre objetos são mantidas.',wraplength=790).pack(anchor='w',pady=6)
    def finished(code,temp):
        state['process']=None;generate.config(state='normal');cancel.config(state='disabled');check.config(state='normal')
        temp.cleanup()
        log.insert('end','\nConcluído. Confira o DXF e o relatório ao lado dele.\n' if code==0 else '\nProcessamento interrompido ou com falha. Consulte as mensagens acima.\n');log.see('end')
    def start():
        if state['process']:return
        if not state['job']:return messagebox.showinfo('Configuração','Abra a configuração do Trimble primeiro.')
        if not state['paths']:return messagebox.showinfo('IFCs','Escolha os IFCs no computador.')
        missing=len(state['job']['models'])-len(state['paths'])
        if missing and not messagebox.askyesno('Arquivos ausentes',f'{missing} modelo(s) sem arquivo local. Gerar DXF parcial com os demais?'):return
        output=filedialog.asksaveasfilename(title='Salvar DXF',defaultextension='.dxf',filetypes=[('DXF','*.dxf')])
        if not output:return
        temp=tempfile.TemporaryDirectory(prefix='corte-dxf-')
        folder=Path(temp.name)
        (folder/'job.json').write_text(json.dumps(state['job']),encoding='utf-8')
        (folder/'map.json').write_text(json.dumps(state['paths']),encoding='utf-8')
        args=[sys.executable,'--worker'] if getattr(sys,'frozen',False) else [sys.executable,'-u',str(Path(__file__).with_name('runner.py'))]
        args += [str(folder/'job.json'),'--map',str(folder/'map.json'),'--output',output,'--cache',str(cache)]
        if confirm.get():args+=['--ifc-coordinates']
        process=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0,env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        state['process']=process;generate.config(state='disabled');cancel.config(state='normal');check.config(state='disabled')
        log.insert('end','\nPreparando os modelos. A primeira leitura pode demorar; os próximos cortes reutilizam o cache.\n')
        def collect():
            for line in process.stdout:messages.put(('line',line))
            messages.put(('done',(process.wait(),temp)))
        threading.Thread(target=collect,daemon=True).start()
    def stop():
        if state['process']:state['process'].terminate()
    generate=ttk.Button(actions,text='Gerar DXF no computador',command=start);generate.pack(side='left',padx=(0,8))
    cancel=ttk.Button(actions,text='Cancelar',command=stop,state='disabled');cancel.pack(side='left')
    def poll():
        try:
            while True:
                kind,value=messages.get_nowait()
                if kind=='line':log.insert('end',value);log.see('end')
                else:finished(*value)
        except queue.Empty:pass
        root.after(150,poll)
    def close():stop();root.destroy()
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
