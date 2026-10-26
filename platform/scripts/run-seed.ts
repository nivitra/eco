import pg from 'pg';
import {seedCatalog} from './seed-catalog.js';
import {readFile} from 'node:fs/promises';
import {importIndependentCatalog,validateIndependentCatalog} from './import-independent-catalog.js';
import {importResearchCatalog,validateResearchCatalog} from './import-hyderabad-research.js';
const url=process.env.ADMIN_DATABASE_URL;if(!url)throw new Error('Seed requires ADMIN_DATABASE_URL');
const pool=new pg.Pool({connectionString:url});
try {
  // Fail on malformed independent input before either seed phase writes anything.
  const independent=validateIndependentCatalog(JSON.parse(await readFile(new URL('../data/independent-places.json',import.meta.url),'utf8')));
  const research=validateResearchCatalog(JSON.parse(await readFile(new URL('../data/research-places.json',import.meta.url),'utf8')));
  await seedCatalog(pool);
  // Preserve historical IDs before retiring imported listings and refreshing
  // independently sourced venues. Merchant/operator changes remain protected.
  const result=await importIndependentCatalog(pool,independent,{apply:true});
  const expanded=await importResearchCatalog(pool,research,{apply:true});
  console.log(JSON.stringify({researchPlaces:expanded.inputCount,researchInserted:expanded.inserted.length,researchUpdated:expanded.updated.length,researchProtected:expanded.protected.length,independentPlaces:result.inputCount,inserted:result.inserted.length,updated:result.updated.length,protected:result.protected.length,retired:result.retired.length}));
} finally {await pool.end();}
