"""Regras do fluxo simplificado do auxiliar (sem abrir janelas)."""
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import time
import unittest

from helper import (default_output, downloads_folder, latest_job, load_settings, needs_confirmation,
                    remember_file, restore_paths, save_settings)


class HelperFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='helper-flow-')
        self.root=Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def touch(self,name,content='{}',age=0):
        path=self.root/name;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(content,encoding='utf-8')
        stamp=time.time()-age;os.utime(path,(stamp,stamp))
        return path

    def test_latest_job_picks_newest_export_including_browser_copies(self):
        self.touch('corte-trimble.json',age=300)
        newest=self.touch('corte-trimble (2).json',age=10)
        self.touch('corte-trimble (1).json',age=100)
        self.touch('outro.json',age=0)            # não é configuração do painel
        self.assertEqual(latest_job(self.root),newest)

    def test_latest_job_without_exports_or_folder(self):
        self.assertIsNone(latest_job(self.root))
        self.assertIsNone(latest_job(self.root/'nao-existe'))

    def test_settings_round_trip_and_corrupt_file(self):
        path=self.root/'cfg'/'settings.json'
        self.assertEqual(load_settings(path),{})
        save_settings({'folder':'C:/Modelos'},path)
        self.assertEqual(load_settings(path),{'folder':'C:/Modelos'})
        path.write_text('{quebrado',encoding='utf-8')
        self.assertEqual(load_settings(path),{})

    def test_remembered_file_only_for_same_revision(self):
        ifc=self.touch('local/model-r3.ifc','ISO-10303-21;')
        r3={'id':'tc01','name':'Galeria TC-01 R3.ifc','versionId':'v3'}
        settings={};remember_file(settings,r3,ifc)
        paths,_,outdated=restore_paths([r3],settings)
        self.assertEqual(paths,{'tc01':str(ifc)})
        self.assertEqual(outdated,[])
        r4={'id':'tc01','name':'Galeria TC-01 R4.ifc','versionId':'v4'}
        paths,_,outdated=restore_paths([r4],settings)
        self.assertEqual(paths,{})                 # não reaproveita a R3 para a R4
        self.assertEqual(outdated,['Galeria TC-01 R4.ifc'])

    def test_unknown_revision_is_not_reused(self):
        ifc=self.touch('a.ifc','ISO-10303-21;')
        item={'id':'x','name':'a.ifc','versionId':''}
        settings={};remember_file(settings,item,ifc)
        self.assertEqual(restore_paths([item],settings)[0],{})

    def test_missing_remembered_file_is_ignored(self):
        item={'id':'x','name':'a.ifc','versionId':'1'}
        settings={};remember_file(settings,item,self.root/'apagado.ifc')
        self.assertEqual(restore_paths([item],settings),({},[],[]))

    def test_saved_folder_matches_remaining_models_by_name(self):
        folder=self.root/'projeto'
        torre=self.touch('projeto/sub/Torre.ifc','ISO-10303-21;')
        manual=self.touch('outra/model-r3.ifc','ISO-10303-21;')
        models=[{'id':'t','name':'Torre.ifc','versionId':'1'},{'id':'g','name':'Galeria R3.ifc','versionId':'3'}]
        settings={'folder':str(folder)};remember_file(settings,models[1],manual)
        paths,ambiguous,outdated=restore_paths(models,settings)
        self.assertEqual(paths,{'t':str(torre),'g':str(manual)})
        self.assertEqual((ambiguous,outdated),([],[]))

    def test_new_revision_found_in_synced_folder_needs_no_warning(self):
        old=self.touch('antigo/Galeria.ifc','ISO-10303-21;')
        synced=self.touch('sync/Galeria.ifc','ISO-10303-21;')
        r1={'id':'g','name':'Galeria.ifc','versionId':'1'}
        settings={'folder':str(self.root/'sync')};remember_file(settings,r1,old)
        paths,_,outdated=restore_paths([{**r1,'versionId':'2'}],settings)
        self.assertEqual(paths,{'g':str(synced)})
        self.assertEqual(outdated,[])

    def test_confirmation_only_for_models_without_three_references(self):
        refs=[{'guid':str(i)} for i in range(3)]
        job={'models':[{'name':'Torre.ifc','referenceObjects':refs},{'name':'R3.ifc','referenceObjects':refs[:1]},{'name':'Sem.ifc'}]}
        self.assertEqual(needs_confirmation(job),['R3.ifc','Sem.ifc'])
        self.assertEqual(needs_confirmation({'models':[{'name':'Torre.ifc','referenceObjects':refs}]}),[])

    def test_default_output_next_to_job_without_overwriting(self):
        job=self.touch('Downloads/corte-trimble.json')
        now=datetime(2026,11,5,21,30)
        first=default_output(job,now)
        self.assertEqual(first,job.with_name('corte_20261105_2130.dxf'))
        first.write_text('x')
        second=default_output(job,now)
        self.assertEqual(second.name,'corte_20261105_2130_2.dxf')
        second.with_name('corte_20261105_2130_2_parcial.dxf').write_text('x')   # parcial também conta
        self.assertEqual(default_output(job,now).name,'corte_20261105_2130_3.dxf')

    def test_downloads_folder_exists(self):
        self.assertTrue(downloads_folder().is_dir())


if __name__=='__main__':unittest.main()
