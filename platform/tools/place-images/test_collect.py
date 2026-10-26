import importlib.util,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('collector',Path(__file__).with_name('collect.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class PlacePhotoTests(unittest.TestCase):
 def setUp(self):
  self.place={'id':'concu-jubilee-hills','name':'Conçu — Jubilee Hills','neighborhood':'Jubilee Hills','sourceURLs':['https://www.concu.in/jubilee-hills']}
  self.row={'contentUrl':'https://reviews.example.org/hyderabad/concu-jubilee-hills','imageUrl':'https://images.example.org/concu.jpg','title':'Concu, Jubilee Hills, Hyderabad'}
 def test_name_area_and_city_match(self):
  score,reason=m.score(self.place,self.row);self.assertGreater(score,0.7);self.assertEqual(reason,'name_and_location')
 def test_another_branch_is_not_assigned_by_brand_alone(self):
  r={**self.row,'title':'Concu Banjara Hills Hyderabad','contentUrl':'https://reviews.example.org/hyderabad/concu-banjara-hills'}
  self.assertEqual(m.score(self.place,r)[1],'conflicting_branch_area')
 def test_unrelated_business_is_rejected_even_in_same_area(self):
  r={**self.row,'title':'Different Bakery Jubilee Hills Hyderabad','contentUrl':'https://reviews.example.org/hyderabad/different-bakery'}
  self.assertEqual(m.score(self.place,r)[1],'weak_place_identity')
 def test_generic_brand_without_local_evidence_is_held(self):
  r={**self.row,'title':'Concu pastries','contentUrl':'https://reviews.example.org/concu'}
  self.assertEqual(m.score(self.place,r)[1],'missing_location_evidence')
 def test_exact_known_source_can_resolve_missing_title(self):
  r={**self.row,'title':'Home','contentUrl':self.place['sourceURLs'][0]};self.assertIsNotNone(m.score(self.place,r)[0])
 def test_logo_and_menu_results_are_held(self):
  for title in ['Concu Jubilee Hills Hyderabad logo','Concu Jubilee Hills Hyderabad menu']:
   self.assertEqual(m.score(self.place,{**self.row,'title':title})[1],'non_photo_content')
 def test_search_thumbnails_are_not_treated_as_original_photos(self):
  r={**self.row,'imageUrl':'https://encrypted-tbn0.gstatic.com/images?q=123'}
  self.assertEqual(m.score(self.place,r)[1],'search_thumbnail_not_original')
 def test_private_addresses_credentials_and_non_http_are_rejected(self):
  for u in ['http://127.0.0.1/a','https://10.0.0.1/a','https://[::1]/a','https://host.internal/a','https://secret@public.example.org/a','file:///etc/passwd']:
   self.assertFalse(m.public_url(u),u)
 def test_queries_include_stable_business_and_area(self):
  q=m.query_for(self.place);self.assertIn('Conçu',q);self.assertIn('Jubilee Hills',q);self.assertIn('Hyderabad',q)
if __name__=='__main__':unittest.main()
