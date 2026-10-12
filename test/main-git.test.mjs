import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const api=await import('../src/main-git.mjs').catch(()=>({}));
for(const mode of ['one-step','stale-main','two-steps'])test('actual Git conditional main advance: '+mode,async()=>{
 assert.equal(typeof api.advanceMain,'function');const dir=await mkdtemp(join(tmpdir(),'integration-main-test-'));
 try{
 const env={PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'Synthetic',GIT_AUTHOR_EMAIL:'synthetic@example.invalid',GIT_COMMITTER_NAME:'Synthetic',GIT_COMMITTER_EMAIL:'synthetic@example.invalid'};
 const git=args=>execFileSync('/usr/bin/git',['--git-dir='+dir,...args],{env,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();execFileSync('/usr/bin/git',['init','--bare',dir],{env,stdio:'pipe'});
 const tree=git(['mktree']),a=git(['commit-tree',tree,'-m','base']),b=git(['commit-tree',tree,'-p',a,'-m','one']),c=git(['commit-tree',tree,'-p',b,'-m','two']);git(['update-ref','refs/heads/main',mode==='stale-main'?c:a]);git(['update-ref','refs/heads/candidate',c]);
 const run=async(program,args,options)=>{const mapped=args.map(v=>v==='https://github.com/owner/project.git'?dir:v);return execFileSync(program,['-c','protocol.file.allow=always',...mapped],{...options,stdio:['pipe','pipe','pipe']});};
 const input={repository:'owner/project',baseSHA:a,commitSHA:mode==='two-steps'?c:b,treeSHA:tree,token:'SYNTHETIC',expiresAt:1100};
 if(mode==='one-step'){await api.advanceMain(input,{run,clock:()=>1000});assert.equal(git(['rev-parse','refs/heads/main']),b);assert.equal(git(['rev-list','--count',a+'..'+b]),'1');}
 else{await assert.rejects(api.advanceMain(input,{run,clock:()=>1000}));assert.equal(git(['rev-parse','refs/heads/main']),mode==='stale-main'?c:a);}
 }finally{await rm(dir,{recursive:true,force:true});}
});
