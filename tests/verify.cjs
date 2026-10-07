// Run: node tests/verify.cjs (requires Playwright and Chromium).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

(async () => {
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(fs.readFileSync(path.resolve(__dirname,'../index.html')));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const localURL='http://127.0.0.1:'+server.address().port;
 const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
 const page = await browser.newPage({viewport:{width:1440,height:1100}});
 const errors = [], requests = [];
 page.on('pageerror', e => errors.push(e.message));
 page.on('request', r => { if (/^https?:/.test(r.url())&&!r.url().startsWith(localURL)) requests.push(r.url()); });
 await page.goto(localURL);
 await page.context().setOffline(true);
 const checks = await page.evaluate(() => {
  const engine=window.RTOSLab;
  const common={mode:'periodic',policy:'fp',horizon:20,seed:42,jitter:0,soft:3,hard:3,tasks:Array.from({length:4},(_,i)=>({period:10,cost:1,offset:i===3?100:0,priority:i+1,deadline:10}))};
  const clone=x=>JSON.parse(JSON.stringify(x));
  let r=engine.simulate(common);
  const baseline={latencies:r.samples.map(x=>x.latency),finishes:r.samples.map(x=>x.finish),busy:r.busy,soft:r.softMiss,hard:r.hardMiss,jobMiss:r.taskMiss};
  let c=clone(common);c.tasks[0].priority=2;c.tasks[1].priority=1;
  r=engine.simulate(c);const sampled={samples:r.samples.map(x=>({id:x.id,latency:x.latency})),pending:r.pending.length};
  c=clone(common);c.mode='event';c.tasks[1].offset=100;c.tasks[2].offset=100;
  r=engine.simulate(c);const event={latencies:r.samples.map(x=>x.latency),sources:r.sources.length};
  c=clone(common);c.tasks[0].cost=4;c.tasks[0].priority=2;c.tasks[1].offset=100;c.tasks[2].offset=100;c.tasks[3].offset=2;c.tasks[3].priority=1;
  r=engine.simulate(c);const preemption={count:r.preemptions,firstFinish:r.jobs.find(j=>j.task===0).finish,segments:r.segments.slice(0,3).map(s=>[s.task,s.start,s.end])};
  c=clone(common);c.policy='edf';c.tasks[3].offset=0;c.tasks[3].deadline=1;c.tasks[3].priority=99;
  r=engine.simulate(c);const edf=r.segments[0].task;
  c=clone(common);c.policy='rm';c.tasks[3].offset=0;c.tasks[3].period=5;
  r=engine.simulate(c);const rm=r.segments[0].task;
  c=clone(common);c.tasks[0].cost=15;
  r=engine.simulate(c);const overload={pending:r.pending.length,miss:r.taskMiss,samples:r.samples.length};
  c=clone(common);c.jitter=30;
  const a=engine.simulate(c),b=engine.simulate(c);const deterministic=JSON.stringify(a.segments)===JSON.stringify(b.segments);
  const violations=[];
  for(const mode of ['periodic','event'])for(const policy of ['fp','edf',...(mode==='periodic'?['rm']:[])])for(let seed=1;seed<8;seed++){
   const config=clone(engine.result.config);config.mode=mode;config.policy=policy;config.seed=seed;config.jitter=35;
   const rr=engine.simulate(config);
   for(let i=1;i<rr.segments.length;i++)if(rr.segments[i].start<rr.segments[i-1].end)violations.push('overlap');
   for(const j of rr.jobs){const work=rr.segments.filter(s=>s.job===j.id).reduce((n,s)=>n+s.end-s.start,0);if(work+j.remaining!==j.cost)violations.push('work accounting');if(j.finish!==null&&work!==j.cost)violations.push('completion');if(j.start!==null&&j.start<j.release)violations.push('release');}
   for(const s of rr.samples){const outputs=rr.jobs.filter(j=>j.task===2&&j.data?.id===s.id&&j.finish!==null);if(s.finish!==Math.min(...outputs.map(j=>j.finish))||s.latency!==s.finish-s.origin)violations.push('lineage');}
   if(rr.samples.length+rr.pending.length!==rr.sources.length)violations.push('source accounting');
  }
  let rejects=0;for(const change of [{soft:40,hard:30},{horizon:.1},{horizon:20.05},{mode:'event',policy:'rm'}]){try{engine.simulate({...clone(common),...change});}catch{rejects++;}}
  return {baseline,sampled,event,preemption,edf,rm,overload,deterministic,violations,rejects,initial:{samples:engine.result.samples.length,max:Math.max(...engine.result.samples.map(s=>s.latency*.1))}};
 });
 assert.deepEqual(checks.baseline,{latencies:[30,30],finishes:[30,130],busy:60,soft:0,hard:0,jobMiss:0});
 assert.deepEqual(checks.sampled,{samples:[{id:1,latency:130}],pending:1});
 assert.deepEqual(checks.event,{latencies:[30,30],sources:2});
 assert.deepEqual(checks.preemption,{count:2,firstFinish:50,segments:[[0,0,20],[3,20,30],[0,30,50]]});
 assert.equal(checks.edf,3);assert.equal(checks.rm,3);
 assert.ok(checks.overload.miss>0);assert.equal(checks.overload.samples,0);
 assert.equal(checks.deterministic,true);assert.deepEqual(checks.violations,[]);assert.equal(checks.rejects,4);
 await page.click('#step');assert.equal(await page.locator('#clock').textContent(),'1.0 ms');
 await page.locator('#seek').evaluate(el=>{el.value='15';el.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await page.locator('#clock').textContent(),'1.5 ms');assert.ok(await page.locator('#card-0').evaluate(el=>el.classList.contains('running')));assert.equal(await page.locator('#card-0 .progress div').evaluate(el=>el.style.width),'50%');
 await page.click('#play');await page.waitForTimeout(450);await page.click('#play');
 const paused=await page.locator('#clock').textContent();assert.notEqual(paused,'1.0 ms');await page.waitForTimeout(200);assert.equal(await page.locator('#clock').textContent(),paused);
 await page.click('#reset');assert.equal(await page.locator('#clock').textContent(),'0.0 ms');
 await page.locator('[data-source]').first().click();assert.equal(await page.locator('[data-source]').first().getAttribute('aria-pressed'),'true');await page.click('#clear-selection');
 await page.selectOption('#mode','event');assert.equal(await page.locator('#t1-period').isDisabled(),true);await page.click('button[type=submit]');assert.equal(await page.evaluate(()=>RTOSLab.result.config.mode),'event');
 await page.fill('#soft','40');await page.click('button[type=submit]');assert.equal(await page.locator('#error').isVisible(),true);assert.equal(await page.evaluate(()=>RTOSLab.result.config.soft),20);
 await page.click('[data-preset=overload]');assert.ok(await page.evaluate(()=>RTOSLab.result.taskMiss>0));
 await page.click('[data-preset=aligned]');const aligned=await page.evaluate(()=>Math.max(...RTOSLab.result.samples.map(s=>s.latency)));await page.click('[data-preset=normal]');assert.ok(aligned<await page.evaluate(()=>Math.max(...RTOSLab.result.samples.map(s=>s.latency))));
 const downloads=path.resolve(__dirname,'../../scratch/rtos-verification');fs.mkdirSync(downloads,{recursive:true});
 for(const [selector,name] of [['#export-csv','results.csv'],['#export-config','config.json']]){const p=page.waitForEvent('download');await page.click(selector);const d=await p;await d.saveAs(path.join(downloads,name));}
 assert.ok(fs.readFileSync(path.join(downloads,'results.csv'),'utf8').includes('soft_miss'));
 assert.equal(JSON.parse(fs.readFileSync(path.join(downloads,'config.json'),'utf8')).seed,42);
 await page.screenshot({path:path.join(downloads,'desktop.png'),fullPage:true});
 for(const width of [360,768,1280]){await page.setViewportSize({width,height:900});await page.evaluate(()=>scrollTo(0,0));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'Overflow at '+width);await page.screenshot({path:path.join(downloads,'width-'+width+'.png'),fullPage:true});}
 await page.setViewportSize({width:640,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='200%');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>document.documentElement.style.fontSize='');
 await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await page.screenshot({path:path.join(downloads,'dark.png'),fullPage:true});
 await page.emulateMedia({media:'print',colorScheme:'light'});await page.pdf({path:path.join(downloads,'print.pdf'),format:'A4',printBackground:true});
 const nojs=await browser.newContext({javaScriptEnabled:false,viewport:{width:360,height:900}});const staticPage=await nojs.newPage();await staticPage.goto(localURL);assert.ok(await staticPage.locator('#guide').textContent());assert.equal(await staticPage.locator('noscript').isVisible(),true);assert.equal(await staticPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await nojs.close();
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 console.log(JSON.stringify({status:'passed',checks,ui:'playback, pause, step, seek/trace, modes, validation, presets, CSV/JSON export',rendering:'360/768/1280 px, narrow viewport, dark, reduced motion, print PDF, no JavaScript',externalRequests:requests.length,screenshots:downloads},null,2));
 await browser.close();
 await new Promise(resolve=>server.close(resolve));
})().catch(e=>{console.error(e);process.exit(1);});
