import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PUBLIC_URL??='http://localhost:3000';process.env.BETTER_AUTH_SECRET??='test-only-auth-secret-never-use-in-production';process.env.OPS_TOKEN??='test-only-ops-token-never-use-in-production';process.env.DATABASE_URL??='postgres://unused:unused@127.0.0.1:1/unused';process.env.AUTH_DATABASE_URL??=process.env.DATABASE_URL;
const {checkedPlannerIntent,plannerIntentSchema}=await import('../src/modules/planner-intent.js');
test('planner intent accepts only interpretations, never catalogue inventions',()=>{
 assert.deepEqual(checkedPlannerIntent({occasion:'date',area:'Jubilee Hills',budgetPerPerson:1000},'date night under ₹2000'),{occasion:'date',area:'Jubilee Hills',budgetPerPerson:1000});
 assert.throws(()=>checkedPlannerIntent({mustInclude:['Invented Bistro']},'date night'));
 assert.throws(()=>checkedPlannerIntent({placeID:'made-up'},'date night'));
 assert.throws(()=>checkedPlannerIntent({window:{start:'tomorrow',end:'late'}},'date night'));
 assert.equal(plannerIntentSchema.safeParse({partySize:0}).success,false);
 assert.equal(plannerIntentSchema.safeParse({budgetPerPerson:-1}).success,false);
 assert.deepEqual(checkedPlannerIntent({mustInclude:['Cafe Bahar']},'include Cafe Bahar'),{mustInclude:['Cafe Bahar']});
});
