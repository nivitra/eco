import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('ingest',Path(__file__).with_name('ingest.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class IngestTests(unittest.TestCase):
 def test_stable_ids_order_and_non_image_facts(self):
  rows=[{'id':'a','name':'Cafe','latitude':17.4,'tags':['local']},{'id':'b','name':'Other'}]
  photos={'a':{'imageURL':'https://cdn.example.org/a.jpg','sourceURL':'https://publisher.example.org/a'}}
  result,added=m.project(rows,photos)
  self.assertEqual(added,['a']);self.assertEqual([r['id'] for r in result],['a','b']);self.assertEqual(result[0]['latitude'],17.4);self.assertEqual(result[0]['tags'],['local']);self.assertEqual(result[1],rows[1]);self.assertNotIn('imageURL',rows[0])
 def test_every_existing_photo_wins(self):
  rows=[{'id':'a','imageURL':'https://owner.example.org/own.jpg','imageRights':'merchant'}]
  result,added=m.project(rows,{'a':{'imageURL':'https://new.example.org/a.jpg','sourceURL':'https://source.example.org/a'}})
  self.assertEqual(result,rows);self.assertEqual(added,[])
 def test_unknown_photo_id_is_not_imported(self):
  rows=[{'id':'a'}];self.assertEqual(m.project(rows,{'b':{}}),(rows,[]))
if __name__=='__main__':unittest.main()
