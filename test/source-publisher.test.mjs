import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const api=await import('../src/source-publisher.mjs').catch(()=>({}));
const sha=c=>c.repeat(40),hash=v=>createHash('sha256').update(v).digest('hex');
function fixture(){
 const calls=[],commands=[],objects=new Map();let tip=null,pull=null,now=1000;
 const config={repository:'owner/project',repositoryID:7,gitDirectory:'/fixture/operator-owned.git',gitPath:'/usr/bin/git',gitDigest:'1'.repeat(64)};
 const credential={token:'SYNTHETIC-BUILDER-TOKEN',repositoryID:7,expiresAt:1200,permissions:{contents:'write',pull_requests:'write',metadata:'read'}};
 const authorization=async request=>({verified:true,requestDigest:hash(JSON.stringify(Object.fromEntries(Object.entries(request).sort()))),expiresAt:1100});
 const git={async putObject(type,bytes){const id=createHash('sha1').update(`${type} ${Buffer.byteLength(bytes)}\0${bytes}`).digest('hex');objects.set(id,bytes);return id;},async readObject(type,id){return objects.get(id);},async pushCreateOnly(input){commands.push(input);tip=input.objectSHA;}};
 const fetcher=async(url,options)=>{calls.push({url,options});const p=new URL(url).pathname;if(p==='/repos/owner/project')return Response.json({id:7,full_name:'owner/project',archived:false,fork:false});if(p==='/repos/owner/project/git/ref/heads/main')return Response.json({ref:'refs/heads/main',object:{sha:sha('a'),type:'commit'}});if(p.startsWith('/repos/owner/project/git/ref/'))return tip?Response.json({ref:'refs/heads/promotion/1/shadow',object:{sha:tip,type:'commit'}}):Response.json({message:'missing'},{status:404});if(p==='/repos/owner/project/pulls'&&options.method==='POST'){const b=JSON.parse(options.body);pull={number:31,html_url:'https://github.com/owner/project/pull/31',state:'open',draft:b.draft,head:{ref:b.head.split(':')[1],sha:tip,repo:{id:7,full_name:'owner/project'}},base:{ref:b.base,sha:sha('a'),repo:{id:7,full_name:'owner/project'}}};return Response.json(pull,{status:201});}if(p==='/repos/owner/project/pulls')return Response.json(pull?[pull]:[]);throw Error('Unexpected synthetic request');};
 return {options:{config,git,credential:async()=>credential,authorize:authorization,fetcher,clock:()=>now},calls,commands,objects,credential,setTime:v=>now=v,setTip:v=>tip=v,setPull:v=>pull=v};
}
test('installed source publisher stages exact Git bytes and creates only its authorized immutable shadow ref',async()=>{
 assert.equal(typeof api.createSourcePublisher,'function');const f=fixture(),p=api.createSourcePublisher(f.options),bytes=`tree ${sha('c')}\nparent ${sha('a')}\nauthor A <a@test.invalid> 1 +0000\ncommitter A <a@test.invalid> 1 +0000\ngpgsig synthetic\n\nTest\n`;
 const id=await p.putObject('commit',bytes);await p.createRef('refs/heads/promotion/1/shadow',id);assert.equal(await p.readRef('refs/heads/promotion/1/shadow'),id);assert.equal(f.commands.length,1);assert.equal(f.commands[0].ref,'refs/heads/promotion/1/shadow');assert.equal(f.commands[0].objectSHA,id);
 await assert.rejects(p.createRef('refs/heads/main',id));await assert.rejects(p.createRef('refs/heads/promotion/01/shadow',id));assert.equal(f.commands.length,1);
});
test('PR adapter uses only fixed GitHub target and reads exact immutable source/base identities',async()=>{
 assert.equal(typeof api.createSourcePublisher,'function');const f=fixture(),p=api.createSourcePublisher(f.options);f.setTip(sha('b'));
 const spec={headRef:'refs/heads/promotion/1/shadow',headSHA:sha('b'),baseRef:'refs/heads/main',baseSHA:sha('a'),title:'Promotion candidate 1',body:'Exact retained source\n',draft:true,maintainerCanModify:false};
 assert.equal(await p.findPullRequest({headRef:spec.headRef,baseRef:spec.baseRef}),null);await p.createPullRequest(spec);const pr=await p.findPullRequest({headRef:spec.headRef,baseRef:spec.baseRef});assert.equal(pr.headSHA,sha('b'));assert.equal(pr.baseSHA,sha('a'));assert.equal(pr.repositoryID,7);
 const post=f.calls.find(c=>c.options.method==='POST');assert.equal(post.url,'https://api.github.com/repos/owner/project/pulls');assert.deepEqual(JSON.parse(post.options.body),{title:spec.title,body:spec.body,head:'owner:promotion/1/shadow',base:'main',draft:true,maintainer_can_modify:false});assert(f.calls.every(c=>c.options.redirect==='error'));
});
test('foreign or expired authority and credentials prevent every provider mutation',async()=>{
 for(const mode of ['authority','expiry','credential','scope']){
  const f=fixture();if(mode==='authority')f.options.authorize=async()=>({verified:true,requestDigest:'0'.repeat(64),expiresAt:1100});if(mode==='expiry')f.options.authorize=async request=>{f.setTime(1101);return {verified:true,requestDigest:hash(JSON.stringify(Object.fromEntries(Object.entries(request).sort()))),expiresAt:1100};};if(mode==='credential')f.credential.repositoryID=99;if(mode==='scope')f.credential.permissions.administration='write';
  assert.equal(typeof api.createSourcePublisher,'function');await assert.rejects(api.createSourcePublisher(f.options).createRef('refs/heads/promotion/1/shadow',sha('b')));assert.equal(f.commands.length,0);assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
 }
});
test('GitHub failures are bounded and sanitized; writes and redirects are never retried',async()=>{
 const f=fixture();assert.equal(typeof api.createSourcePublisher,'function');f.options.fetcher=async(url,options)=>{f.calls.push({url,options});return new Response('SYNTHETIC-PRIVATE'.repeat(40000),{status:500});};await assert.rejects(api.createSourcePublisher(f.options).readRef('refs/heads/promotion/1/shadow'),e=>!e.message.includes('SYNTHETIC'));assert.equal(f.calls.length,1);
});
test('PR creation independently rejects main drift before POST',async()=>{
 const f=fixture();f.setTip(sha('b'));const original=f.options.fetcher;f.options.fetcher=async(url,options)=>url.endsWith('/git/ref/heads/main')?Response.json({ref:'refs/heads/main',object:{sha:sha('f'),type:'commit'}}):original(url,options);
 await assert.rejects(api.createSourcePublisher(f.options).createPullRequest({headRef:'refs/heads/promotion/1/shadow',headSHA:sha('b'),baseRef:'refs/heads/main',baseSHA:sha('a'),title:'Promotion candidate 1',body:'Exact retained source\n',draft:true,maintainerCanModify:false}));assert.equal(f.calls.filter(c=>c.options.method==='POST').length,0);
});
