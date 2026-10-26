#!/usr/bin/env node
// Offline/dry-run only. No credential loading, API requests or apply operation.
function buildPlan(hostname,plan='free'){
 if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname||''))throw Error('A canonical hostname is required');
 const endpoint=`(http.host eq "${hostname}" and http.request.uri.path in {"/mcp" "/mcp/"})`;
 return {dryRun:true,hostname,observedPlan:plan,customRules:[
  {description:'MCP transport methods only',enabled:false,action:'block',expression:`${endpoint} and not http.request.method in {"POST" "OPTIONS"}`},
  {description:'Optional UK/US geography, incomplete AI-client exceptions: do not activate',enabled:false,action:'block',
   expression:`${endpoint} and not ip.src.country in {"GB" "US"} and not ip.src in {160.79.104.0/21}`},
 ],rateLimitingRules:[],decisions:[
  'No browser challenge, blanket data-centre block, zone-wide Bot Fight Mode or global IP Access allow rule.',
  'Free rate-limit expression fields do not include Host: a path-only zone rule would exceed the approved hostname scope. Use origin account/anonymous limits; no unsupported rule generated.',
  'Claude outbound CIDR verified from official documentation; OpenAI hosted-client egress exceptions remain unverified. Geography remains disabled.',
  'Read existing rules and capacity before proposing any merge. This tool cannot apply or replace rules.',
 ]};
}
if(require.main===module){try{const args=process.argv.slice(2);if(args.some(x=>!x.startsWith('--hostname=')&&!x.startsWith('--plan=')))throw Error('Only offline --hostname and --plan are supported');const value=k=>args.find(x=>x.startsWith(`--${k}=`))?.split('=')[1];process.stdout.write(JSON.stringify(buildPlan(value('hostname'),value('plan')||'free'),null,2)+'\n')}catch(e){process.stderr.write(e.message+'\n');process.exitCode=1}}
module.exports={buildPlan};
