import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discoveryAliases,discoveryCategories,discoverySchema,canCreateDiscoveryOuting,outingCategoryIDs,selectDiscoveryCandidates,type DiscoveryCategoryID} from '../src/modules/ai-discovery.js';
import type {CatalogPlace} from '../src/modules/consumer.js';
const place=(id:string,category:string,tags:string[]=[]):CatalogPlace=>({id,name:'A source listing',category,tags,neighborhood:'Hyderabad',address:'Hyderabad',summary:'Source-backed facts',sourceURLs:['https://official.example/'+id],researchedAt:'2026-10-10',searchQuery:id,revision:1,status:'research'});
const added:DiscoveryCategoryID[]=['movies','events','hotels','flights','bus','taxis','train_meals','bills_recharge','chemists','grocery','books','repairs','automobile','florists','acting','dance','aerobics','apparel','atms','auditoriums','auto_accessories','banquets','cleaning','computers','consultants','dietitians','dth'];
test('56 sectors accept strict IDs and only exact category/tag evidence',()=>{
 assert.equal(Object.keys(discoveryAliases).length,56);
 for(const id of added){
  assert.equal(discoverySchema.parse({goal:'discover',categoryID:id}).categoryID,id);
  assert(discoveryCategories(place('a','unknown',[id])).includes(id),id);
  assert(!discoveryCategories({...place('b','unknown'),name:id,summary:id}).includes(id),id);
  assert(!discoveryCategories(place('c','unknown',['nearby '+id])).includes(id),id);
 }
 assert.throws(()=>discoverySchema.parse({goal:'discover',categoryID:'flight_booking_confirmed'}));
});
test('care, transaction and specialist service evidence vetoes broad leisure categories',()=>{
 for(const tag of ['pharmacy','dietitian','computer repair','acting school','dance studio','bill payment','airline office','car accessories','banquet hall'])assert(!canCreateDiscoveryOuting(place('a','shopping',[tag])),tag);
 for(const tag of ['bookstore','cinema','apparel','auditorium','event venue'])assert(canCreateDiscoveryOuting(place('b','community',[tag])),tag);
 assert(!discoveryCategories(place('c','education',['film school'])).includes('movies'));
 assert(!discoveryCategories(place('d','healthcare',['hospital'])).includes('chemists'));
 assert.deepEqual(discoveryCategories(place('e','unknown',['COMPUTER_REPAIR'])),['repairs','computers']);
 assert.deepEqual(added.filter(id=>outingCategoryIDs.includes(id)),['movies','events','books','apparel','auditoriums']);
});
test('underrepresented sectors stay empty instead of substituting providers or nearby cafes',()=>{
 const catalogue=[place('coffee','cafes'),place('library','community',['bookstore']),place('pharmacy','shopping',['pharmacy'])];
 const input=(id:DiscoveryCategoryID)=>({messages:[{role:'user' as const,content:'Show source listings'}],scope:'hyderabad' as const,taste:{interests:[],avoidBars:false},savedIDs:[],discovery:{goal:'discover' as const,categoryID:id,savedOnly:false}});
 assert.deepEqual(selectDiscoveryCandidates(catalogue,input('dth')).results,[]);
 assert.deepEqual(selectDiscoveryCandidates(catalogue,input('books')).results.map(r=>r.place.id),['library']);
 assert.deepEqual(selectDiscoveryCandidates(catalogue,input('chemists')).results.map(r=>r.place.id),['pharmacy']);
});
