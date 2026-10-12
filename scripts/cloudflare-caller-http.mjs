// Built-ins only. OIDC and response values remain in memory and never become logs.
export const HEX=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const exact=(value,keys)=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===keys.slice().sort().join();
export function requireValue(value){if(!value)throw Error('Caller denied');}
export function context(env,config){
 requireValue(config.enabled===true&&env.GITHUB_REPOSITORY===config.repository&&env.GITHUB_REPOSITORY_ID===String(config.repositoryID)&&env.GITHUB_REPOSITORY_OWNER_ID==='215839550');
 requireValue(env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REF==='refs/heads/main'&&SHA.test(env.GITHUB_SHA??'')&&env.GITHUB_WORKFLOW_SHA===env.GITHUB_SHA&&env.GITHUB_WORKFLOW_REF===`${config.repository}/.github/workflows/${config.workflow}@refs/heads/main`);
 for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])requireValue(/^[1-9][0-9]*$/.test(env[key]??'')&&Number.isSafeInteger(Number(env[key])));
 return {runID:Number(env.GITHUB_RUN_ID),runAttempt:Number(env.GITHUB_RUN_ATTEMPT),workflowSHA:env.GITHUB_SHA};
}
export async function jsonRequest(fetcher,url,options={},timeout=15000){
 requireValue(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=30000);
 const response=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(timeout)});
 if(!response.ok){await response.body?.cancel();throw Error('Remote request denied');}
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>32768)){await response.body?.cancel();throw Error('Response too large');}
 const reader=response.body?.getReader();requireValue(reader);const parts=[];let count=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;count+=value.byteLength;if(count>32768){await reader.cancel();throw Error('Response too large');}parts.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(count);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export function identityRequest(env,audience){
 const url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
 requireValue(url.protocol==='https:'&&url.hostname.endsWith('.actions.githubusercontent.com')&&!url.port&&!url.username&&!url.password&&!url.hash);
 const bearer=env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;requireValue(typeof bearer==='string'&&/^[\x21-\x7e]{1,16384}$/.test(bearer));
 url.searchParams.set('audience',audience);return {url,headers:{Authorization:'Bearer '+bearer}};
}
export async function identity(fetcher,request,timeout=15000){
 const result=await jsonRequest(fetcher,request.url,{headers:request.headers},timeout);
 requireValue(typeof result.value==='string'&&result.value.length<=16384&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.value));return result.value;
}
export function post(fetcher,url,body,timeout=15000){return jsonRequest(fetcher,url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},timeout);}
