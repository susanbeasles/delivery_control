import {pathToFileURL} from 'node:url';
import {HEX,UUID,context,exact,identityRequest,identity,post,requireValue} from './cloudflare-caller-http.mjs';

export const CONFIG=Object.freeze({enabled:false,repository:'susanbeasles/delivery_control',repositoryID:1405415291,workflow:'execute-cloudflare.yml'});
const authority='https://pipeline.vespoli.me',deployer='https://deploy.vespoli.me',audience='delivery-control-cloudflare-deployer';
export async function execute({operationID,env=process.env,config=CONFIG,fetcher=fetch,clock=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),report=()=>{}}){
 try{
  const who=context(env,config);requireValue(HEX.test(operationID??''));
  const request=identityRequest(env,audience+':'+operationID),deadline=clock()+120000;
  const remaining=()=>{const value=Math.min(15000,Math.floor(deadline-clock()));requireValue(value>0);return value;};
  report({operationID,state:'waiting-for-authorization',repositoryID:config.repositoryID,...who});
  const pollingIdentity=await identity(fetcher,request,remaining());let authorized=false;
  for(let attempt=0;attempt<24;attempt++){
   const status=await post(fetcher,authority+'/v1/deployments/status',{operationID,oidcToken:pollingIdentity,runID:who.runID,runAttempt:who.runAttempt},remaining());
   remaining();requireValue(exact(status,['operationID','state'])&&status.operationID===operationID&&['pending','authorized'].includes(status.state));
   if(status.state==='authorized'){authorized=true;break;}
   if(attempt<23)await sleep(Math.min(5000,remaining()));
  }
  requireValue(authorized);
  // One execute request only. A lost response may mean a provider mutation;
  // retained durable state, not an automatic caller retry, resolves that case.
  const oidcToken=await identity(fetcher,request,remaining());remaining();
  const receipt=await post(fetcher,deployer+'/v1/deployments/execute',{operationID,oidcToken},30000);
  requireValue(exact(receipt,['operationID','state','artifactDigest','versionID','deploymentID'])&&receipt.operationID===operationID&&receipt.state==='completed'&&HEX.test(receipt.artifactDigest)&&UUID.test(receipt.versionID)&&UUID.test(receipt.deploymentID));return receipt;
 }catch{throw Error('Cloudflare execution request unavailable');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const receipt=await execute({operationID:process.env.CLOUDFLARE_OPERATION_ID,report:value=>console.log(JSON.stringify(value))});console.log(JSON.stringify(receipt));}
 catch{console.error('Cloudflare execution request unavailable; reconcile retained operation before retrying.');process.exitCode=1;}
}
