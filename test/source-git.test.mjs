import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const api=await import('../src/source-git.mjs').catch(()=>({}));
const sha=c=>c.repeat(40),hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(){const gitDirectory=await mkdtemp(join(tmpdir(),'source-git-fixture-'));execFileSync('/usr/bin/git',['init','--bare','--quiet',gitDirectory],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'});const gitPath=await realpath('/usr/bin/git');return {config:{repository:'owner/project',repositoryID:7,gitDirectory,gitPath,gitDigest:hash(await readFile(gitPath))},close:()=>rm(gitDirectory,{recursive:true,force:true})};}
test('normal Git transport stores and verifies exact signed-object bytes in an isolated synthetic bare repository',async()=>{
 assert.equal(typeof api.createNormalGitTransport,'function');const f=await fixture();try{const git=api.createNormalGitTransport({config:f.config});const body=`tree ${sha('c')}\nparent ${sha('a')}\nauthor A <a@test.invalid> 1 +0000\ncommitter A <a@test.invalid> 1 +0000\ngpgsig synthetic\n\nTest\n`;const id=await git.putObject('commit',body);assert.equal(await git.readObject('commit',id),body);assert.equal(id,createHash('sha1').update(`commit ${Buffer.byteLength(body)}\0${body}`).digest('hex'));}finally{await f.close();}
});
test('one source push has exact create-only lease, no hooks or credential arguments, and no retry',async()=>{
 assert.equal(typeof api.createNormalGitTransport,'function');const f=await fixture(),calls=[];try{const git=api.createNormalGitTransport({config:f.config,clock:()=>1000,run:async(program,args,options)=>{calls.push({program,args,options});if(args.includes('config'))return Buffer.from('core.repositoryformatversion\n0\0core.filemode\ntrue\0core.bare\ntrue\0');if(args.includes('cat-file'))return Buffer.from('commit\n');if(args.includes('push'))throw Error('SYNTHETIC-SECRET failure');throw Error('Unexpected command');}});
 await assert.rejects(git.pushCreateOnly({repository:'owner/project',repositoryID:7,ref:'refs/heads/int/source',objectSHA:sha('b'),token:'SYNTHETIC-TOKEN',expiresAt:1100}),e=>!e.message.includes('SYNTHETIC'));const pushed=calls.filter(c=>c.args.includes('push'));assert.equal(pushed.length,1);assert(pushed[0].args.includes('--force-with-lease=refs/heads/int/source:'));assert(pushed[0].args.includes(`${sha('b')}:refs/heads/int/source`));assert(pushed[0].args.includes('https://github.com/owner/project.git'));assert(!JSON.stringify(pushed[0].args).includes('SYNTHETIC'));assert.equal(pushed[0].options.env.GIT_CONFIG_KEY_0,'http.https://github.com/owner/project.git.extraheader');assert(pushed[0].args.includes('core.hooksPath=/dev/null'));
 }finally{await f.close();}
});
test('untrusted local Git configuration, executable drift, main refs and expired transport grants fail before any push',async()=>{
 assert.equal(typeof api.createNormalGitTransport,'function');for(const mode of ['configuration','executable','ref','expiry']){const f=await fixture();let pushes=0;try{if(mode==='configuration')execFileSync('/usr/bin/git',['--git-dir='+f.config.gitDirectory,'config','url.https://evil.test/.insteadOf','https://github.com/'],{stdio:'pipe'});if(mode==='executable')f.config.gitDigest='0'.repeat(64);const git=api.createNormalGitTransport({config:f.config,clock:()=>1000,run:async(program,args,options)=>{if(args.includes('push')){pushes++;throw Error('Synthetic push interception');}if(args.includes('cat-file'))return Buffer.from('commit\n');return execFileSync(program,args,{cwd:options.cwd,env:options.env,stdio:'pipe'});}});await assert.rejects(git.pushCreateOnly({repository:'owner/project',repositoryID:7,ref:mode==='ref'?'refs/heads/main':'refs/heads/int/source',objectSHA:sha('b'),token:'SYNTHETIC-TOKEN',expiresAt:mode==='expiry'?999:1100}));assert.equal(pushes,0);}finally{await f.close();}}
});
test('integration deletion uses an exact old-SHA lease and cannot delete main',async()=>{
 const f=await fixture(),calls=[];try{
 const git=api.createNormalGitTransport({config:f.config,clock:()=>1000,run:async(program,args)=>{calls.push(args);return args.includes('config')?Buffer.from('core.bare\ntrue\0'):Buffer.from('');}});
 assert.equal(typeof git.pushDeleteOnly,'function');
 const input={repository:'owner/project',repositoryID:7,ref:'refs/heads/int/feature/ticket.1',expectedSHA:sha('b'),token:'SYNTHETIC',expiresAt:1100};
 await git.pushDeleteOnly(input);
 const push=calls.find(a=>a.includes('push'));assert(push.includes('--force-with-lease='+input.ref+':'+sha('b')));assert(push.includes(':'+input.ref));
 await assert.rejects(git.pushDeleteOnly({...input,ref:'refs/heads/main'}));assert.equal(calls.filter(a=>a.includes('push')).length,1);
 }finally{await f.close();}
});
test('real remote refuses deletion after the integration ref was replaced',async()=>{
 const f=await fixture(),remote=await mkdtemp(join(tmpdir(),'integration-remote-'));
 try{
 const env={PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'};
 execFileSync('/usr/bin/git',['init','--bare','--quiet',remote],{env});
 const local=args=>execFileSync('/usr/bin/git',['--git-dir='+f.config.gitDirectory,...args],{env,encoding:'utf8',stdio:'pipe'}).trim();
 const tree=local(['mktree']),a=local(['commit-tree',tree,'-m','first']),b=local(['commit-tree',tree,'-p',a,'-m','replacement']);
 local(['push',remote,b+':refs/heads/int/feature/ticket']);
 const run=async(program,args,options)=>execFileSync(program,['-c','protocol.file.allow=always',...args.map(x=>x==='https://github.com/owner/project.git'?remote:x)],{...options,stdio:'pipe'});
 const transport=api.createNormalGitTransport({config:f.config,clock:()=>1000,run});const input={repository:'owner/project',repositoryID:7,ref:'refs/heads/int/feature/ticket',expectedSHA:a,token:'SYNTHETIC',expiresAt:1100};
 await assert.rejects(transport.pushDeleteOnly(input));assert.equal(execFileSync('/usr/bin/git',['--git-dir='+remote,'rev-parse',input.ref],{encoding:'utf8'}).trim(),b);
 await transport.pushDeleteOnly({...input,expectedSHA:b});assert.throws(()=>execFileSync('/usr/bin/git',['--git-dir='+remote,'show-ref','--verify',input.ref],{stdio:'pipe'}));
 }finally{await f.close();await rm(remote,{recursive:true,force:true});}
});
