// Run with: node thumbnail.browser.test.cjs (requires Playwright and Chromium).
const {chromium}=require('playwright');
const http=require('node:http'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fs.readFileSync(__dirname+'/index.html'))});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true});
  for(const observer of [true,false]){
   const context=await browser.newContext({viewport:{width:390,height:844}});
   if(!observer)await context.addInitScript(()=>{delete window.IntersectionObserver});
   const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>typeof db!=='undefined'&&!!db);
   await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;const ctx=canvas.getContext('2d');ctx.fillStyle='#447faa';ctx.fillRect(0,0,256,256);const blob=await new Promise(resolve=>canvas.toBlob(resolve));
    state=blank();state.groups.g={id:'g',name:'Test',order:[]};state.groupOrder=['g'];
    const tr=db.transaction(['assets','settings'],'readwrite');
    for(let i=0;i<120;i++){const id='qa-'+i;state.photos[id]={id,name:id+'.png',type:'image/png',importAt:i+1,modified:i,size:blob.size,showAll:true,hidden:false,deletedAt:null,groupIds:['g']};state.allOrder.push(id);state.groups.g.order.push(id);tr.objectStore('assets').put({id,blob,thumb:i===119?new Blob(['bad image'],{type:'image/jpeg'}):blob})}
    tr.objectStore('settings').put(state,'state');await new Promise((resolve,reject)=>{tr.oncomplete=resolve;tr.onerror=reject});render();scrollToLatest();
   });
   const assertVisible=async()=>page.waitForFunction(()=>{const c=document.querySelector('#content').getBoundingClientRect();const imgs=[...document.querySelectorAll('#content img[data-img-id]')].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>c.top+50&&r.top<c.bottom});return imgs.length>0&&imgs.every(img=>img.complete&&img.naturalWidth>0&&img.dataset.thumbLoaded==='1')},{},{timeout:12000});
   await assertVisible();
   // Returning from distant scrolls must refill evicted thumbnails, even without IO.
   for(let i=0;i<16;i++){await page.evaluate(i=>{const c=$('#content');c.scrollTop=i%2?c.scrollHeight:0;scanVisibleThumbs()},i);await assertVisible()}
   // Pending reads from older renders must not clear new jobs or revoke their URLs.
   await page.evaluate(()=>{const original=txGet;let failures=0;txGet=async(...args)=>{if(args[0]==='assets'){await new Promise(r=>setTimeout(r,35));if(failures++<8)throw Error('transient read error')}return original(...args)};for(const img of $('#content').querySelectorAll('img[data-img-id]'))releaseThumb(img);loadThumbs()});
   for(let i=0;i<12;i++){await page.evaluate(i=>{ui.tab=i%2?'all':'groups';ui.group=i%2?null:'g';render();scrollToLatest()},i)}
   await assertVisible();
   // Re-rendering already loaded visible images must reuse the decoded DOM nodes.
   const retained=await page.evaluate(()=>{const before=[...$('#content').querySelectorAll('img[data-img-id]')].filter(x=>x.dataset.thumbLoaded);render();return before.every(x=>x.isConnected&&x.complete&&x.naturalWidth>0)});assert.equal(retained,true);
   await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pageshow'))});await assertVisible();
   assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>Object.keys(state.photos).length),120);
   console.log('PASS: '+(observer?'IntersectionObserver':'scroll fallback')+'; scroll, corrupt thumbnail fallback, render races, read errors, image reuse, resume');
   await context.close();
  }
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve))}
})().catch(e=>{console.error(e);process.exitCode=1});
