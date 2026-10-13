const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'inline app script exists');
new vm.Script(script);

function extract(name) {
  const asyncStart = script.indexOf('async function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : script.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let pos = script.indexOf('{', start), depth = 0;
  for (let i = pos; i < script.length; i++) {
    if (script[i] === '{') depth++;
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error('unclosed function ' + name);
}

test('selection sync updates all tiles and all trash rows without throwing', () => {
  const tiles = ['a', 'b'].map(id => ({dataset:{photoId:id},classList:{toggle(){},remove(){}}}));
  const rows = ['a', 'b'].map(id => ({dataset:{trashId:id},classList:{toggle(){}},querySelector:()=>({textContent:''})}));
  const content = {scrollTop:10,classList:{toggle(){}}};
  const gallery = {classList:{toggle(){}}};
  const area = {innerHTML:''};
  const context = {
    ui:{selected:true,arrange:false,ids:new Set(['a']),trashSelecting:true,trashIds:new Set(['b'])},
    $: selector => ({'#content':content,'#gallery':gallery,'#toolArea':area})[selector],
    $$: selector => selector.startsWith('#gallery') ? tiles : rows,
    regularSelectionToolbar:()=>'',trashSelectionToolbar:()=>'',header:()=>{},
  };
  vm.createContext(context);
  vm.runInContext(extract('syncRegularSelectionUI')+'\n'+extract('syncTrashSelectionUI'), context);
  assert.doesNotThrow(()=>context.syncRegularSelectionUI());
  assert.doesNotThrow(()=>context.syncTrashSelectionUI());
  assert.equal(content.scrollTop,10);
});

test('failed save does not advance state, undo or redo history', async () => {
  const context = {stateSaving:false,state:{count:1},history:[],future:[],render:()=>{},header:()=>{},toast:()=>{},console:{error(){}},txPut:async()=>{throw Error('quota')}};
  vm.createContext(context);
  vm.runInContext(extract('withStateSave')+'\n'+extract('persist')+'\n'+extract('snapshot')+'\n'+extract('change')+'\n'+extract('changeWithoutRender')+'\n'+extract('undo')+'\n'+extract('redo'),context);
  await assert.rejects(context.change(()=>context.state.count++), /quota/);
  assert.equal(context.state.count,1);
  assert.equal(context.history.length,0);
  context.history.push('{"count":0}');
  await assert.rejects(context.undo(), /quota/);
  assert.equal(context.state.count,1);
  assert.equal(context.history.length,1);
  assert.equal(context.future.length,0);
});

test('existing 900 photo records keep their IDs and default order', () => {
  const photos = {}, allOrder = [];
  for (let i = 0; i < 900; i++) {
    const id = 'photo-' + i;
    photos[id] = {id,importAt:i + 1,showAll:true,hidden:false,deletedAt:null};
    allOrder.push(id);
  }
  const context = {
    state:{photos,allOrder,manualViewAll:null,sort:{all:'manual'}},
    ui:{tab:'all',page:null,group:null},
  };
  vm.createContext(context);
  vm.runInContext([
    extract('photo'),extract('available'),extract('manualNeedsReverse'),
    extract('manualOldestFirst'),extract('canArrangePhotos'),extract('getSort'),extract('visibleIds'),
  ].join('\n'),context);
  const ids = context.visibleIds();
  assert.equal(ids.length,900);
  assert.equal(ids[0],'photo-0');
  assert.equal(ids[899],'photo-899');
  assert.equal(Object.keys(photos).length,900);
});

test('storage diagnosis reads counts without writing to IndexedDB', async () => {
  const operations = [];
  const context = {
    db:{transaction(name,mode){operations.push([name,mode]);return {objectStore(){return {count(){const r={};queueMicrotask(()=>{r.result=900;r.onsuccess()});return r}}}}}},
    txGet:async(store,key)=>{operations.push([store,key]);return {photos:{a:{},b:{}},groups:{g:{}}}},
    location:{origin:'https://example.test'},window:{matchMedia:()=>({matches:true})},navigator:{standalone:false},
  };
  vm.createContext(context);
  vm.runInContext(extract('storageDiagnostics'),context);
  const result=await context.storageDiagnostics();
  assert.equal(result.assets,900);
  assert.equal(result.records,2);
  assert.equal(result.groups,1);
  assert.deepEqual(operations,[['assets','readonly'],['settings','state']]);
});

test('organization restore relinks 900 reimported photos without touching assets', () => {
  const oldPhotos={},newPhotos={},oldOrder=[],newOrder=[],assets=new Map();
  for(let i=0;i<900;i++){
    oldPhotos['old-'+i]={id:'old-'+i,name:'IMG_'+i+'.jpg',size:100+i,modified:1000+i,groupIds:i<30?['trip']:[],showAll:i>=30,hidden:i===899,deletedAt:null};
    newPhotos['new-'+i]={id:'new-'+i,name:'IMG_'+i+'.jpg',size:100+i,modified:1000+i,groupIds:[],showAll:true,hidden:false,deletedAt:null};
    oldOrder.push('old-'+i);newOrder.push('new-'+i);assets.set('new-'+i,{blob:'original-'+i});
  }
  const current={photos:newPhotos,allOrder:newOrder,hiddenOrder:[],manualViewAll:null,groups:{existing:{id:'existing',name:'Existing',order:[]}},groupOrder:['existing'],sort:{all:'manual',hidden:'manual',groups:{}}};
  const backup={format:'NagisaPhotoSortOrganizationV1',state:{photos:oldPhotos,allOrder:oldOrder.slice().reverse(),hiddenOrder:['old-899'],manualViewAll:null,groups:{trip:{id:'trip',name:'Trip',order:oldOrder.slice(0,30)}},groupOrder:['trip'],sort:{all:'manual',hidden:'manual',groups:{trip:'manual'}}}};
  const context={importKey:p=>[p.name,p.size,p.modified].join('\0')};
  vm.createContext(context);
  vm.runInContext(extract('buildOrganizationRestore'),context);
  const {next,matched,groups}=context.buildOrganizationRestore(backup,current);
  assert.equal(matched,900);assert.equal(groups,1);
  assert.equal(next.allOrder[0],'new-899');
  assert.equal(next.photos['new-0'].showAll,false);
  assert.equal(next.photos['new-899'].hidden,true);
  assert.equal(JSON.stringify(next.groups.existing),JSON.stringify(current.groups.existing));
  assert.equal(next.groups['recovered-trip'].order.length,30);
  assert.equal(assets.size,900);
  assert.equal(current.photos['new-0'].showAll,true);
});

test('organization restore rejects unrelated backup without changing current photos', () => {
  const current={photos:{a:{id:'a',name:'A',size:1,modified:1,groupIds:[],showAll:true}},allOrder:['a'],hiddenOrder:[],groups:{},groupOrder:[],sort:{all:'manual',hidden:'manual',groups:{}}};
  const backup={format:'NagisaPhotoSortOrganizationV1',state:{photos:{b:{id:'b',name:'B',size:2,modified:2}},allOrder:['b'],groupOrder:[],groups:{}}};
  const context={importKey:p=>[p.name,p.size,p.modified].join('\0')};vm.createContext(context);vm.runInContext(extract('buildOrganizationRestore'),context);
  assert.throws(()=>context.buildOrganizationRestore(backup,current),/一致する写真がありません/);
  assert.equal(current.allOrder[0],'a');
});

test('incomplete full backup is refused before any database write', async () => {
  let transactions=0;const messages=[];
  const context={state:{photos:{},groups:{}},db:{transaction(){transactions++;throw Error('unexpected write')}},toast:x=>messages.push(x),confirm:()=>true,console};
  vm.createContext(context);vm.runInContext(extract('withStateSave')+'\n'+extract('restoreBackup'),context);
  const incomplete={format:'NagisaPhotoSortBackupV1',state:{photos:{lost:{}}},assets:{}};
  await context.restoreBackup({text:async()=>JSON.stringify(incomplete)});
  assert.equal(transactions,0);
  assert.ok(messages.some(x=>x.includes('完全なバックアップ')));
  assert.equal(Object.keys(context.state.photos).length,0);
});

test('full restore refuses to replace existing photo records', async () => {
  let read=false;const messages=[];
  const context={state:{photos:{present:{}},groups:{}},toast:x=>messages.push(x)};
  vm.createContext(context);vm.runInContext(extract('withStateSave')+'\n'+extract('restoreBackup'),context);
  await context.restoreBackup({text:async()=>{read=true;return '{}'}});
  assert.equal(read,false);
  assert.ok(messages.some(x=>x.includes('既存の整理データを守るため')));
});

test('full restore refuses to replace an existing empty group', async () => {
  let read=false;const context={state:{photos:{},groups:{kept:{id:'kept',name:'Kept',order:[]}}},toast(){}};
  vm.createContext(context);vm.runInContext(extract('withStateSave')+'\n'+extract('restoreBackup'),context);
  await context.restoreBackup({text:async()=>{read=true;return '{}'}});
  assert.equal(read,false);
});

test('failed full restore keeps current state and reports failure', async () => {
  const messages=[],original={photos:{},groups:{}};
  const context={stateSaving:false,state:original,toast:x=>messages.push(x),confirm:()=>true,fromDataUrl:async()=>({size:5}),console:{error(){}},
    db:{transaction(){const tr={objectStore:()=>({add(){},put(){}}),abort(){queueMicrotask(()=>tr.onabort())}};queueMicrotask(()=>tr.onabort());return tr}}};
  vm.createContext(context);vm.runInContext(extract('withStateSave')+'\n'+extract('restoreBackup'),context);
  const backup={format:'NagisaPhotoSortBackupV1',state:{photos:{new:{}}},assets:{new:{blob:'data:image/jpeg;base64,AA=='}}};
  await context.restoreBackup({text:async()=>JSON.stringify(backup)});
  assert.equal(context.state,original);
  assert.ok(messages.some(x=>x.includes('元の保存データは変更')));
});

test('full backup refuses missing photo data', async () => {
  const context={Blob,b64:async()=>'',setTimeout};
  vm.createContext(context);vm.runInContext(extract('buildBackupBlob'),context);
  await assert.rejects(context.buildBackupBlob({photos:{a:{id:'a'}}},async()=>undefined),/画像データが不足/);
});

test('overlapping saves are refused and failure releases the save lock', async () => {
  let rejectSave;
  const context={stateSaving:false,state:{count:0},history:[],future:[],render(){},header(){},toast(){},console:{error(){}},txPut:()=>new Promise((_,reject)=>{rejectSave=reject})};
  vm.createContext(context);vm.runInContext(['withStateSave','persist','snapshot','change'].map(extract).join('\n'),context);
  const saving=context.change(()=>context.state.count++);
  await assert.rejects(context.change(()=>context.state.count+=100),/保存中/);
  rejectSave(new Error('quota'));await assert.rejects(saving,/quota/);
  assert.equal(context.state.count,0);assert.equal(context.stateSaving,false);
  context.txPut=async()=>{};await context.change(()=>context.state.count++);
  assert.equal(context.state.count,1);assert.equal(context.history.length,1);
});

test('failed sort save preserves sort and keeps current menu open', async () => {
  let closed=false;
  const context={stateSaving:false,state:{sort:{all:'manual'}},ui:{tab:'all',arrange:false},history:[],future:[],render(){},header(){},toast(){},console:{error(){}},txPut:async()=>{throw Error('quota')},closePopup(){closed=true},viewStartsAtLatest:()=>false};
  vm.createContext(context);vm.runInContext(['withStateSave','runUI','persist','snapshot','changeWithoutRender','setSort'].map(extract).join('\n'),context);
  await context.setSort('filename');
  assert.equal(context.state.sort.all,'manual');assert.equal(closed,false);assert.equal(context.history.length,0);
});

test('entering arrange mode does not alter saved photo state', () => {
  const state={sort:{all:'filename'},manualViewAll:null};
  const context={state,stateSaving:false,importing:false,ui:{tab:'all',group:null,search:false,selected:false,arrange:false},syncRegularSelectionUI(){},canArrangePhotos:()=>true,showArrangeControls(){}};
  vm.createContext(context);vm.runInContext(extract('activateAllArrange'),context);
  assert.equal(context.activateAllArrange(['b','a']),true);
  assert.equal(state.sort.all,'filename');assert.equal(state.manualViewAll,null);
  assert.equal(context.ui.arrange,true);assert.equal(context.ui.arrangeOrder.join(','),'b,a');
});

for(const kind of ['photo','group'])test(`cancelled ${kind} drag redraws persisted order without saving`,async()=>{
  let redraws=0,writes=0;
  const nodes=kind==='photo'?[{dataset:{photoId:'b'}},{dataset:{photoId:'a'}}]:[{dataset:{groupId:'b'}},{dataset:{groupId:'a'}}];
  const source={parentElement:{querySelectorAll:()=>nodes},classList:{remove(){}}};
  const context={drag:{kind,source,autoFrame:0,beforeView:['a','b'],beforeOrder:['a','b']},ui:{},$:()=>({scrollTop:25}),clearDrag(){context.drag=null},setTimeout(){},cancelAnimationFrame(){},render(){redraws++},changeWithoutRender(){writes++},toast(){}};
  vm.createContext(context);vm.runInContext(extract(kind==='photo'?'finishPhotoDrag':'finishGroupDrag'),context);
  await (kind==='photo'?context.finishPhotoDrag(false):context.finishGroupDrag(false));
  assert.equal(redraws,1);assert.equal(writes,0);
});

test('900 photo backup produces compatible JSON and reports every item',async()=>{
  const photos=Object.fromEntries(Array.from({length:900},(_,i)=>['photo-'+i,{id:'photo-'+i}]));
  let progress=0;
  const context={Blob,b64:async b=>'data:image/jpeg;base64,'+Buffer.from(await b.arrayBuffer()).toString('base64'),setTimeout};
  vm.createContext(context);vm.runInContext(extract('buildBackupBlob'),context);
  const blob=await context.buildBackupBlob({photos},async id=>({blob:new Blob([id])}),(done,total)=>{progress=done;assert.equal(total,900)});
  const data=JSON.parse(await blob.text());
  assert.equal(data.format,'NagisaPhotoSortBackupV1');assert.equal(Object.keys(data.assets).length,900);assert.equal(progress,900);
  assert.equal(Buffer.from(data.assets['photo-899'].blob.split(',')[1],'base64').toString(),'photo-899');
  assert.equal(blob.type,'application/json');
});

test('cancelled backup stops loading more assets and returns no partial file',async()=>{
  let loads=0,cancel=false;
  const context={Blob,b64:async()=>'',setTimeout};vm.createContext(context);vm.runInContext(extract('buildBackupBlob'),context);
  await assert.rejects(context.buildBackupBlob({photos:{a:{},b:{}}},async()=>{loads++;return {blob:new Blob(['a'])}},()=>{cancel=true},()=>cancel),/backup-cancelled/);
  assert.equal(loads,1);
});

test('empty All distinguishes filtered photos from an empty library',()=>{
  const content={innerHTML:''};
  const context={state:{photos:{a:{id:'a',showAll:false}}},ui:{tab:'all',arrange:false},visibleIds:()=>[],getSort:()=> 'manual',$:()=>content,available:p=>p&&!p.deletedAt};
  vm.createContext(context);vm.runInContext(extract('renderGallery'),context);context.renderGallery();
  assert.match(content.innerHTML,/「すべて」に表示する写真がありません/);
  assert.doesNotMatch(content.innerHTML,/まだ写真がありません/);
  context.state.photos={};context.renderGallery();
  assert.match(content.innerHTML,/まだ写真がありません/);assert.match(content.innerHTML,/data-action="import"/);
});

test('service worker only removes old caches owned by this app',async()=>{
  const handlers={},deleted=[];
  const context={self:{addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim:async()=>{}},location:{origin:'https://example.test'}},caches:{keys:async()=>['photo-sorter-ui-v1','photo-sorter-ui-v31','another-app'],delete:async name=>deleted.push(name)},Promise};
  vm.createContext(context);vm.runInContext(fs.readFileSync(__dirname+'/sw.js','utf8'),context);
  let done;handlers.activate({waitUntil:p=>done=p});await done;
  assert.deepEqual(deleted,['photo-sorter-ui-v1']);
});

test('opening 900 originals retains only three object URLs',async()=>{
  let created=0;const revoked=[];
  const context={urls:new Map(),ui:{viewerId:null},URL:{createObjectURL:()=> 'blob:test-'+(++created),revokeObjectURL:u=>revoked.push(u)},txGet:async()=>({blob:new Blob(['photo'])})};
  vm.createContext(context);vm.runInContext(extract('rememberFullUrl')+'\n'+extract('assetUrl'),context);
  for(let i=0;i<900;i++){context.ui.viewerId='p'+i;await context.assetUrl('p'+i,false)}
  assert.equal(context.urls.size,3);assert.equal(revoked.length,897);assert.equal(context.urls.has('p899f'),true);
  await context.assetUrl('p899',false);assert.equal(created,900);
});


function groupArrangeContext(){
  const photos=Object.fromEntries(['a','b','c','hidden','deleted'].map((id,i)=>[id,{id,importAt:i+1,name:id,modified:i,groupIds:['g','other'],showAll:true,hidden:id==='hidden',deletedAt:id==='deleted'?1:null}]));
  const context={stateSaving:false,importing:false,state:{photos,hiddenOrder:[],allOrder:['c','b','a'],manualViewAll:['a','b','c'],groups:{g:{id:'g',order:['c','b','a','hidden','deleted']},other:{id:'other',order:['a','b','c']}},sort:{all:'manual',groups:{g:'filename',other:'manual'}}},ui:{tab:'groups',group:'g',arrange:false,selected:false,search:false},history:[],future:[],persist:async()=>{},render(){},header(){},toast(){},console:{error(){}},syncRegularSelectionUI(){},syncArrangeSelectionUI(){},showArrangeControls(){}};
  vm.createContext(context);vm.runInContext(['photo','available','manualNeedsReverse','manualOldestFirst','canArrangePhotos','getSort','visibleIds','savePhotoOrder','activateAllArrange','arrange','withStateSave','snapshot','change','changeWithoutRender','undo','redo','runUI'].map(extract).join('\n'),context);return context;
}

test('group arrangement persists exact order independently and survives reload, undo and redo',async()=>{
  const c=groupArrangeContext(),before=JSON.stringify(c.state);
  assert.equal(c.activateAllArrange(c.visibleIds()),true);assert.equal(JSON.stringify(c.state),before);
  const order=c.visibleIds();c.arrange(order,'a','c');
  await c.change(()=>c.savePhotoOrder(order));c.ui.arrange=false;
  assert.equal(c.visibleIds().join(','),'b,a,c');
  assert.equal(c.state.manualViewAll.join(','),'a,b,c');assert.equal(c.state.groups.other.order.join(','),'a,b,c');
  assert.equal(c.state.groups.g.order.join(','),'c,b,a,hidden,deleted');assert.equal(Object.keys(c.state.photos).length,5);
  c.state=JSON.parse(JSON.stringify(c.state));assert.equal(c.visibleIds().join(','),'b,a,c');
  await c.undo();assert.equal(c.state.sort.groups.g,'filename');assert.equal(c.state.groups.g.manualView,undefined);
  await c.redo();assert.equal(c.visibleIds().join(','),'b,a,c');
  const reversed=c.visibleIds().reverse();await c.change(()=>c.savePhotoOrder(reversed));assert.equal(c.visibleIds().join(','),'c,a,b');
});

test('group drag saves group order and leaves All unchanged; failed save rolls back',async()=>{
  const c=groupArrangeContext(),nodes=['c','a','b'].map(id=>({dataset:{photoId:id}}));let writes=0;
  Object.assign(c,{$:()=>({scrollTop:20}),setTimeout(){},cancelAnimationFrame(){},clearDrag(){c.drag=null}});
  vm.runInContext(extract('finishPhotoDrag'),c);
  const start=()=>{c.drag={kind:'photo',tab:'groups',gid:'g',source:{parentElement:{querySelectorAll:()=>nodes},classList:{remove(){}}},beforeView:['a','b','c']}};
  c.persist=async()=>{writes++};start();await c.finishPhotoDrag();c.ui.arrange=false;
  assert.equal(writes,1);assert.equal(c.visibleIds().join(','),'c,a,b');assert.equal(c.state.manualViewAll.join(','),'a,b,c');
  const before=JSON.stringify(c.state);nodes.reverse();c.persist=async()=>{throw Error('quota')};start();await c.finishPhotoDrag();assert.equal(JSON.stringify(c.state),before);
});

test('group touch long press enters arrangement while group list and search do not',()=>{
  const c=groupArrangeContext(),handlers={};let timer;
  Object.assign(c,{$:()=>({addEventListener:(name,fn)=>handlers[name]=fn}),setTimeout:fn=>{timer=fn;return 1},beginPhotoDrag:()=>true});
  const start=script.indexOf("$('#content').addEventListener('touchstart',e=>{if(stateSaving||importing||e.touches.length!==1||ui.selected||ui.search)return;const tile=");
  const end=script.indexOf("$('#content').addEventListener('touchmove'",start);
  vm.runInContext('let photoTouch=null;'+script.slice(start,end),c);
  const event={touches:[{identifier:1,clientX:10,clientY:10}],target:{closest:()=>({})}};
  handlers.touchstart(event);timer();assert.equal(c.ui.arrange,true);assert.equal(c.state.sort.groups.g,'filename');
  c.ui.arrange=false;c.ui.group=null;timer=null;handlers.touchstart(event);assert.equal(timer,null);
  c.ui.group='g';c.ui.search=true;handlers.touchstart(event);assert.equal(timer,null);
});

test('group manual order preserves excluded photos and adds newly visible photos',()=>{
  const c=groupArrangeContext();c.savePhotoOrder(['c','a','b']);c.state.photos.hidden.hidden=false;
  assert.equal(c.visibleIds().join(','),'c,a,b,hidden');assert.equal(c.state.groups.g.order.includes('deleted'),true);
});

test('organization backup relinks the exact manual order within a group',()=>{
  const c=groupArrangeContext();c.savePhotoOrder(['c','a','b']);
  for(const p of Object.values(c.state.photos)){p.size=1;p.modified=1}
  const current=JSON.parse(JSON.stringify(c.state));current.groups={};current.groupOrder=[];current.sort.groups={};
  const backup={format:'NagisaPhotoSortOrganizationV1',state:{...c.state,groupOrder:['g']}};
  c.importKey=p=>p.name;vm.runInContext(extract('buildOrganizationRestore'),c);
  const result=c.buildOrganizationRestore(backup,current);assert.equal(result.next.groups['recovered-g'].manualView.join(','),'c,a,b');
});

function thumbnailContext(){
 const revoked=[],timers=[];const c={thumbEpoch:1,thumbQueue:[],thumbActive:0,thumbObserver:null,thumbJobs:new WeakMap(),THUMB_CONCURRENCY:5,drag:null,Date,document:{hidden:false},window:{},URL:{revokeObjectURL:u=>revoked.push(u)},setTimeout:(fn,delay)=>{timers.push({fn,delay});return timers.length},clearTimeout(){},requestAnimationFrame:fn=>{fn();return 1},$:()=>null,console};
 vm.createContext(c);vm.runInContext(['releaseThumb','thumbPriority','currentThumbJob','queueThumb','loadOneThumb','pumpThumbs','scanVisibleThumbs','loadThumbs'].map(extract).join('\n'),c);
 c.scheduleThumbScan=()=>{};
 const image=id=>({isConnected:true,dataset:{imgId:id},complete:false,naturalWidth:0,removeAttribute(name){delete this[name]},getBoundingClientRect:()=>({top:20,bottom:120})});
 return {c,revoked,timers,image};
}

test('thumbnail remains valid when scrolling outside observer during decoding',async()=>{
 const {c,image,revoked}=thumbnailContext(),img=image('a');let finish;c.prepareThumb=()=>new Promise(resolve=>finish=resolve);
 const job={img,id:'a',epoch:1};c.thumbJobs.set(img,job);img.dataset.thumbWanted='1';const work=c.loadOneThumb(job);
 delete img.dataset.thumbWanted;finish('blob:decoded');await work;
 assert.equal(img.src,'blob:decoded');assert.equal(img.dataset.thumbLoaded,'1');assert.deepEqual(revoked,[]);
});

test('stale thumbnail completion cannot clear or revoke a newer request',async()=>{
 const {c,image,revoked}=thumbnailContext(),img=image('a');const pending=[];c.prepareThumb=()=>new Promise(resolve=>pending.push(resolve));
 const old={img,id:'a',epoch:1};c.thumbJobs.set(img,old);const first=c.loadOneThumb(old);
 c.thumbEpoch=2;const newer={img,id:'a',epoch:2};c.thumbJobs.set(img,newer);img.dataset.thumbLoading='1';const second=c.loadOneThumb(newer);
 pending[0]('blob:stale');await first;assert.equal(c.thumbJobs.get(img),newer);assert.equal(img.dataset.thumbLoading,'1');
 pending[1]('blob:current');await second;assert.equal(img.src,'blob:current');assert.deepEqual(revoked,['blob:stale']);assert.equal(c.thumbJobs.has(img),false);
});

test('decode failure falls back to original and never marks a failed thumbnail as loaded',async()=>{
 const {c,image}=thumbnailContext(),img=image('a');const calls=[];c.prepareThumb=async(id,fallback)=>{calls.push(!!fallback);if(!fallback)throw Error('bad thumbnail');return 'blob:original'};
 const job={img,id:'a',epoch:1};c.thumbJobs.set(img,job);await c.loadOneThumb(job);
 assert.deepEqual(calls,[false,true]);assert.equal(img.dataset.thumbLoaded,'1');assert.equal(img.src,'blob:original');
 img.onerror();assert.equal(img.dataset.thumbLoaded,undefined);
});

test('thumbnail failures keep retrying beyond two attempts without holding a loader slot',async()=>{
 const {c,image,timers}=thumbnailContext(),img=image('a');c.prepareThumb=async()=>{throw Error('read temporarily failed')};
 for(let i=0;i<5;i++){const job={img,id:'a',epoch:1};c.thumbJobs.set(img,job);await c.loadOneThumb(job);assert.equal(c.thumbJobs.has(img),false);assert.equal(img.dataset.thumbLoaded,undefined)}
 assert.equal(timers.length,5);assert.equal(img.dataset.thumbRetries,'5');assert.ok(timers.every(x=>x.delay<=30000));
});

test('scroll scan reloads visible thumbnails without IntersectionObserver or an entry callback',()=>{
 const {c,image}=thumbnailContext(),near=image('near'),far=image('far');far.getBoundingClientRect=()=>({top:5000,bottom:5100});
 const queued=[];c.queueThumb=img=>queued.push(img.dataset.imgId);c.$=()=>({getBoundingClientRect:()=>({top:0,bottom:800}),querySelectorAll:()=>[near,far]});
 c.scanVisibleThumbs();assert.deepEqual(queued,['near']);
 far.getBoundingClientRect=()=>({top:400,bottom:500});c.scanVisibleThumbs();assert.deepEqual(queued,['near','near','far']);
});

test('thumbnail preparation rejects decode errors and releases failed URL; timeout releases late URL',async()=>{
 const revoked=[],timers=[];let source;
 const c={assetUrl:async()=> 'blob:broken',Image:class{async decode(){throw Error('decode failed')}},URL:{revokeObjectURL:u=>revoked.push(u)},setTimeout:fn=>{timers.push(fn);return 1},clearTimeout(){}};
 vm.createContext(c);vm.runInContext(extract('prepareThumb'),c);
 await assert.rejects(c.prepareThumb('a'),/decode failed/);assert.deepEqual(revoked,['blob:broken']);
 c.assetUrl=()=>new Promise(resolve=>source=resolve);const late=c.prepareThumb('b');timers.at(-1)();await assert.rejects(late,/タイムアウト/);source('blob:late');await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(revoked,['blob:broken','blob:late']);
});

test('render retains already decoded images rather than replacing them with blank nodes',()=>{
 const {c,image,revoked}=thumbnailContext(),old=image('a');old.complete=true;old.naturalWidth=256;old.dataset.thumbLoaded='1';old.dataset.thumbUrl='blob:good';old.src='blob:good';
 let imgs=[old];const content={classList:{remove(){}},querySelectorAll:()=>imgs};
 Object.assign(c,{$:selector=>selector==='#content'?content:{innerHTML:''},ui:{tab:'all'},header(){},bottom(){},syncSelectionUI(){},loadThumbs(){},renderGallery(){old.isConnected=false;const fresh=image('a');fresh.alt='Photo';fresh.replaceWith=node=>{node.isConnected=true;imgs=[node]};imgs=[fresh]}});
 vm.runInContext(extract('render'),c);c.render();assert.equal(imgs[0],old);assert.equal(old.src,'blob:good');assert.deepEqual(revoked,[]);
});

test('bulk movement preserves display order and handles scattered selection in both directions',()=>{
 const c={};vm.createContext(c);vm.runInContext(extract('movePhotoBlock'),c);
 const order=['a','b','c','d','e','f'];
 assert.equal(c.movePhotoBlock(order,['d','b'],'f').join(','),'a,c,e,b,d,f');
 assert.equal(c.movePhotoBlock(order,['e','c'],'a').join(','),'c,e,a,b,d,f');
 assert.equal(c.movePhotoBlock(order,['b','d'],'f',true).join(','),'a,c,e,f,b,d');
 assert.equal(c.movePhotoBlock(order,['b','d'],'b').join(','),order.join(','));
 assert.equal(c.movePhotoBlock(order,['b','d'],'absent').join(','),order.join(','));
 assert.equal(order.join(','),'a,b,c,d,e,f');
});

test('bulk drag moves only selected existing tile nodes and leaves their image objects intact',()=>{
 const order=['a','b','c','d','e'];const imgs=order.map(id=>({id}));let nodes=order.map((id,i)=>({dataset:{photoId:id},img:imgs[i],getBoundingClientRect:()=>({left:0,width:100})}));
 const gallery={querySelectorAll:()=>nodes,insertBefore(node,ref){nodes=nodes.filter(n=>n!==node);const at=ref?nodes.indexOf(ref):nodes.length;nodes.splice(at,0,node)}};nodes.forEach(n=>n.parentElement=gallery);
 let animations=0;const c={drag:{ids:['b','d']},photoLayout:()=>new Map(),animatePhotoLayout:()=>animations++};vm.createContext(c);vm.runInContext(extract('movePhotoBlock')+'\n'+extract('movePhotoDom'),c);
 const source=nodes[1],target=nodes[4];c.movePhotoDom(source,target,99);
 assert.equal(nodes.map(n=>n.dataset.photoId).join(','),'a,c,e,b,d');assert.equal(animations,1);assert.equal(nodes.find(n=>n.dataset.photoId==='b'),source);assert.equal(source.img,imgs[1]);
});

test('bulk drag cancel keeps pending selection and performs no save',async()=>{
 const c=groupArrangeContext();let writes=0,redraws=0;c.persist=async()=>writes++;c.render=()=>redraws++;c.ui.moveIds=['a','c'];
 const source={parentElement:{querySelectorAll:()=>['a','c','b'].map(id=>({dataset:{photoId:id}}))},classList:{remove(){}}};
 Object.assign(c,{drag:{kind:'photo',bulk:true,ids:['a','c'],sources:[source],source,beforeView:['a','b','c'],autoFrame:0},$:()=>({scrollTop:30}),clearDrag(){c.drag=null},syncArrangeSelectionUI(){},setTimeout(){},cancelAnimationFrame(){}});
 vm.runInContext(extract('finishPhotoDrag'),c);await c.finishPhotoDrag(false);assert.equal(writes,0);assert.equal(redraws,1);assert.equal(c.ui.moveIds.join(','),'a,c');
});

for(const tab of ['all','groups'])test(`direct ${tab} arranging: taps only select, long press drags selection and commits once`,async()=>{
 const c=groupArrangeContext();c.ui.tab=tab;c.ui.group=tab==='groups'?'g':null;let syncs=0;
 let nodes=['a','b','c'].map(id=>({isConnected:true,dataset:{photoId:id},classList:{add(){},remove(){}},getBoundingClientRect:()=>({left:0,width:100})}));
 const gallery={querySelectorAll:()=>nodes,insertBefore(node,ref){nodes=nodes.filter(n=>n!==node);nodes.splice(ref?nodes.indexOf(ref):nodes.length,0,node)}};nodes.forEach(n=>n.parentElement=gallery);
 Object.assign(c,{drag:null,syncArrangeSelectionUI:()=>syncs++,photoLayout:()=>new Map(),animatePhotoLayout(){},requestAnimationFrame:()=>1,cancelAnimationFrame(){},autoScrollPhotoDrag(){},makePhotoGhost:()=>({node:{append(){}}}),document:{createElement:()=>({})},$:()=>({scrollTop:42}),clearDrag(){c.drag=null},setTimeout(){}});
 vm.runInContext("'use strict';\n"+['toggleArrangePhoto','beginPhotoDrag','movePhotoBlock','movePhotoDom','finishPhotoDrag'].map(extract).join('\n'),c);
 const before=JSON.stringify(c.state);assert.equal(c.activateAllArrange(c.visibleIds()),true);
 c.toggleArrangePhoto('c');c.toggleArrangePhoto('a');c.toggleArrangePhoto('c');assert.equal(c.ui.moveIds.join(','),'a');c.toggleArrangePhoto('c');assert.equal(c.ui.moveIds.join(','),'a,c');
 assert.equal(c.history.length,0);assert.equal(JSON.stringify(c.state),before);
 assert.equal(c.beginPhotoDrag(nodes[0],10,10),true);assert.equal(c.drag.ids.join(','),'a,c');
 const target=nodes[1];c.movePhotoDom(nodes[0],target,99);assert.equal(nodes.map(n=>n.dataset.photoId).join(','),'b,a,c');
 await c.finishPhotoDrag();assert.equal(c.history.length,1);assert.equal(c.visibleIds().join(','),'b,a,c');assert.equal(c.ui.moveIds.join(','),'a,c');assert.ok(syncs>=5);
 if(tab==='groups')assert.equal(c.state.manualViewAll.join(','),'a,b,c');else assert.equal(c.state.groups.g.manualView,undefined);
 c.ui.arrange=false;await c.undo();assert.equal(JSON.stringify(c.state),before);
});

test('bulk toolbar contains only needed actions with Delete in the non-scrolling action row',()=>{
 const c={ui:{selected:true,ids:new Set(['a']),group:null},visibleIds:()=>['a','b']};vm.createContext(c);vm.runInContext(extract('regularSelectionToolbar'),c);
 const all=c.regularSelectionToolbar();assert.doesNotMatch(all,/move-selected|toggle-show|選んだ写真を並べ替え|すべて表示切替/);assert.match(all,/selection-actions/);
 assert.equal((all.match(/data-action=/g)||[]).length,4);assert.match(all,/data-action="delete"/);
 c.ui.group='g';const group=c.regularSelectionToolbar();assert.equal((group.match(/data-action=/g)||[]).length,5);assert.match(group,/data-action="remove-group"/);
 assert.match(html,/\.selection-toolbar\{display:block;overflow:visible\}/);assert.match(html,/\.selection-actions button\{flex:1;min-width:0;white-space:normal/);
});
