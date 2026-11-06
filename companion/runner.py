"""Offline companion: a Trimble cut job plus local IFCs produces a federated DXF."""
from pathlib import Path
import argparse
import json
import math
import sys
import time
import numpy as np
from ezdxf.addons import Importer

from geometry import prepare
from drawing import canonical, draw_model, new_document


def alignment(manifest, item, confirmed_ifc=False):
    if confirmed_ifc: return np.eye(4)
    boxes = {}
    for mesh in manifest['meshes']:
        guid = canonical(mesh['guid'])
        low, high = np.array(mesh['min']), np.array(mesh['max'])
        if guid in boxes:
            low = np.minimum(low, boxes[guid][0]); high = np.maximum(high, boxes[guid][1])
        boxes[guid] = low, high
    pairs = [(boxes[canonical(ref['guid'])], ref['boundingBox']) for ref in item.get('referenceObjects', []) if canonical(ref['guid']) in boxes]
    if len(pairs) < 3:
        raise ValueError('Alinhamento nao verificavel: menos de tres objetos comuns. Confirme as coordenadas originais dos IFCs ou escolha mais referencias no Trimble.')
    a = np.array([(low+high)/2 for (low,high), _ in pairs])
    b = np.array([(np.array(box['min'])+box['max'])/2 for _,box in pairs])
    # Centre distances are invariant under rotation; AABB diagonals are not.
    ratios = [np.linalg.norm(b[j]-b[i])/np.linalg.norm(a[j]-a[i])
              for i in range(len(a)) for j in range(i+1,len(a)) if np.linalg.norm(a[j]-a[i])>1e-6]
    if not ratios: raise ValueError('Referencias coincidentes: nao e possivel verificar a unidade')
    exponent = math.log10(float(np.median(ratios)))
    if not math.isfinite(exponent) or abs(exponent-round(exponent))>.15:
        raise ValueError('Unidades incoerentes nas referencias de alinhamento')
    units = 10**round(exponent)
    b = b/units
    keep = np.ones(len(a),dtype=bool)
    for _ in range(4):
        ac,bc = a[keep].mean(axis=0),b[keep].mean(axis=0)
        aa,bb = a[keep]-ac,b[keep]-bc
        if np.sum(aa[:,:2]**2)<1e-8: raise ValueError('Referencias sem separacao horizontal para verificar rotacao')
        theta = math.atan2(np.sum(aa[:,0]*bb[:,1]-aa[:,1]*bb[:,0]), np.sum(aa[:,:2]*bb[:,:2]))
        c,s = math.cos(theta),math.sin(theta)
        r = np.array([[c,-s,0],[s,c,0],[0,0,1.]])
        shift = bc-r@ac
        errors = np.linalg.norm(a@r.T+shift-b,axis=1)
        keep = errors <= max(3*float(np.median(errors)),.05)
        if keep.sum()<3: raise ValueError('Menos de tres referencias coerentes')
    if errors[keep].max()>.1: raise ValueError('Erro de alinhamento superior a 10 cm')
    result=np.eye(4);result[:3,:3]=r;result[:3,3]=shift
    return result


def validate_job(job):
    if job.get('schema')!='corte-dxf-job' or job.get('version')!=1: raise ValueError('Configuracao de corte invalida ou incompativel')
    if not isinstance(job.get('models'),list) or not job['models']: raise ValueError('Configuracao sem modelos')
    if len(job['models'])>500: raise ValueError('Numero de modelos excessivo')
    drawing=job['drawing']
    if drawing.get('units') not in ('m','mm'): raise ValueError('Unidade invalida')
    return job


def run(job, paths, output, cache, confirmed_ifc=False, progress=print):
    validate_job(job)
    started=time.perf_counter()
    doc=new_document(job['drawing']['units'])
    results=[]; failed=[]
    for item in job['models']:
        try:
            source=paths.get(item['id'])
            if not source: raise ValueError('IFC local nao escolhido')
            progress('Modelo: '+item['name'])
            manifest=prepare(source,cache,progress)
            repaired=sum(mesh.get('repairedFaceCount',0) for mesh in manifest['meshes'])
            degenerate=sum(mesh.get('degenerateFaceCount',0) for mesh in manifest['meshes'])
            if repaired or degenerate:
                progress(f'AVISO: {repaired} face(s) com contorno corrigido; {degenerate} face(s) sem area. Confira o relatorio do DXF.')
            transform=alignment(manifest,item,confirmed_ifc)
            drawing={**job['drawing']}
            if 'selectedGuids' in item: drawing['selectedGuids']=item['selectedGuids']
            staged=new_document(drawing['units'])
            stats=draw_model(staged,manifest,manifest['cachePath'],drawing,transform,progress)
            # An IFC is incorporated only after all its geometry/drawing succeeds.
            importer=Importer(staged,doc);importer.import_modelspace();importer.finalize()
            coverage={key:sum(mesh.get(key,0) for mesh in manifest['meshes']) for key in ('sourceFaceCount','expectedFaceCount','triangleCount','degenerateFaceCount','repairedFaceCount')}
            results.append({'model':item['name'],'sha256':manifest['source']['sha256'],'cacheHit':manifest['cacheHit'],
                            'meshCount':len(manifest['meshes']),**coverage,
                            'maxPlanarityDeviationM':max((mesh.get('maxPlanarityDeviationM',0) for mesh in manifest['meshes']),default=0),
                            'repairExamples':[example for mesh in manifest['meshes'] for example in mesh.get('repairExamples',[])][:20],**stats})
        except Exception as error:
            failed.append({'model':item['name'],'reason':str(error)})
            progress('IGNORADO: '+item['name']+' - '+str(error))
    report={'engine':'Corte DXF Local 1','elapsedSeconds':round(time.perf_counter()-started,3),'confirmedIfcCoordinates':confirmed_ifc,'hiddenLinesRemoved':False,'models':results,'omitted':failed}
    path=Path(output)
    if failed: path=path.with_name(path.stem+'_parcial'+path.suffix)
    report_path=path.with_suffix('.relatorio.json')
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    if not results: raise RuntimeError('Nenhum IFC processado. Consulte '+str(report_path))
    if not len(doc.modelspace()): raise RuntimeError('Nenhuma linha encontrada neste corte. Confira o plano e a profundidade.')
    audit=doc.audit()
    if audit.has_errors: raise RuntimeError('O DXF falhou na verificacao de integridade')
    temp=path.with_suffix('.tmp.dxf');doc.saveas(temp);temp.replace(path)
    progress('DXF salvo: '+str(path))
    return path,report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('job');p.add_argument('--folder',default='.')
    p.add_argument('--map',help='JSON: modelId -> local path')
    p.add_argument('--output',default='corte.dxf');p.add_argument('--cache',default=str(Path.home()/'.corte-dxf'/'cache'))
    p.add_argument('--ifc-coordinates',action='store_true',help='Confirmar uso das coordenadas originais IFC; dispensa alinhamento automatico')
    args=p.parse_args()
    job=validate_job(json.loads(Path(args.job).read_text(encoding='utf-8-sig')))
    paths=json.loads(Path(args.map).read_text(encoding='utf-8-sig')) if args.map else {}
    for item in job['models']:
        candidate=Path(args.folder)/Path(item['name']).name
        if item['id'] not in paths and candidate.is_file(): paths[item['id']]=str(candidate)
    try: run(job,paths,args.output,args.cache,args.ifc_coordinates,lambda msg:print(msg,flush=True))
    except Exception as error: print('ERRO: '+str(error),file=sys.stderr);sys.exit(1)


if __name__=='__main__': main()
