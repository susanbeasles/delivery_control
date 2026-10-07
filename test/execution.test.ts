import test from 'node:test';
import assert from 'node:assert/strict';
import {execute} from '../src/execute.mjs';
const operationID='a'.repeat(64),sha=char=>char.repeat(40);
function fixture(mode='allow') {
 let writes=0,revokes=0,checks=0,tip=sha('b');const outcomes=[];
 const intent={repository:'owner/fixture',repositoryID:7,branch:'main',baseSHA:sha('b'),commitSHA:sha('c'),treeSHA:sha('d')};
 const options={operationID,controller:'https://controller.example/',oidcURL:'https://run.actions.githubusercontent.com/token',oidcBearer:'fixture',audiencePrefix:'repoctl'};
 const fetcher=async(url,request={})=>{
  url=String(url);
  if(url.includes('.actions.githubusercontent.com'))return Response.json({value:'fixture-oidc'});
  if(url.endsWith('/lease'))return Response.json({operationID,token:'fixture-token',operationExpiresAt:1200,intent});
  if(url.endsWith('/check')){checks++;assert.equal(request.method,'POST');if(mode==='deny')return new Response('',{status:403});return Response.json({operationID,verified:true,operationExpiresAt:mode==='expired'?900:1200,intent:mode==='foreign'?{...intent,commitSHA:sha('e')}:intent});}
  if(url.endsWith('/complete')){outcomes.push(JSON.parse(request.body).outcome);return Response.json({});}
  if(url.endsWith('/installation/token')){revokes++;return new Response(null,{status:204});}
  if(url.endsWith('/repos/owner/fixture'))return Response.json({id:7});
  if(url.includes('/git/commits/'))return Response.json({sha:intent.commitSHA,parents:[{sha:intent.baseSHA}],tree:{sha:intent.treeSHA},verification:{verified:true}});
  if(request.method==='PATCH'){assert.equal(checks,1);writes++;tip=intent.commitSHA;}
  return Response.json({object:{sha:tip}});
 };
 return {options,fetcher,result:()=>({writes,revokes,checks,outcomes})};
}
test('executor requires fresh exact controller confirmation immediately before one protected update',async()=>{
 const f=fixture();await execute(f.options,f.fetcher,()=>1000);assert.deepEqual(f.result(),{writes:1,revokes:1,checks:1,outcomes:['updated']});
});
test('denied, expired or foreign check prevents update and retains cleanup and completion',async()=>{
 for(const mode of ['deny','expired','foreign']){const f=fixture(mode);await assert.rejects(execute(f.options,f.fetcher,()=>1000));assert.deepEqual(f.result(),{writes:0,revokes:1,checks:1,outcomes:['failed']});}
});
