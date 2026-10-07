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
  const context = {state:{count:1},history:[],future:[],render:()=>{},header:()=>{},toast:()=>{},console:{error(){}},txPut:async()=>{throw Error('quota')}};
  vm.createContext(context);
  vm.runInContext(extract('persist')+'\n'+extract('snapshot')+'\n'+extract('change')+'\n'+extract('changeWithoutRender')+'\n'+extract('undo')+'\n'+extract('redo'),context);
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
    extract('manualOldestFirst'),extract('getSort'),extract('visibleIds'),
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
  const context={state:{photos:{}},db:{transaction(){transactions++;throw Error('unexpected write')}},toast:x=>messages.push(x),confirm:()=>true,console};
  vm.createContext(context);vm.runInContext(extract('restoreBackup'),context);
  const incomplete={format:'NagisaPhotoSortBackupV1',state:{photos:{lost:{}}},assets:{}};
  await context.restoreBackup({text:async()=>JSON.stringify(incomplete)});
  assert.equal(transactions,0);
  assert.ok(messages.some(x=>x.includes('完全なバックアップ')));
  assert.equal(Object.keys(context.state.photos).length,0);
});

test('full restore refuses to replace existing photo records', async () => {
  let read=false;const messages=[];
  const context={state:{photos:{present:{}}},toast:x=>messages.push(x)};
  vm.createContext(context);vm.runInContext(extract('restoreBackup'),context);
  await context.restoreBackup({text:async()=>{read=true;return '{}'}});
  assert.equal(read,false);
  assert.ok(messages.some(x=>x.includes('既存の写真を守るため')));
});

test('failed full restore keeps current state and reports failure', async () => {
  const messages=[],original={photos:{}};
  const context={state:original,toast:x=>messages.push(x),confirm:()=>true,fromDataUrl:async()=>({size:5}),console:{error(){}},
    db:{transaction(){const tr={objectStore:()=>({put(){}}),abort(){queueMicrotask(()=>tr.onabort())}};queueMicrotask(()=>tr.onabort());return tr}}};
  vm.createContext(context);vm.runInContext(extract('restoreBackup'),context);
  const backup={format:'NagisaPhotoSortBackupV1',state:{photos:{new:{}}},assets:{new:{blob:'data:image/jpeg;base64,AA=='}}};
  await context.restoreBackup({text:async()=>JSON.stringify(backup)});
  assert.equal(context.state,original);
  assert.ok(messages.some(x=>x.includes('元の保存データは変更')));
});

test('full backup refuses to export when a photo asset is missing', async () => {
  let downloaded=false;const messages=[];
  const context={state:{photos:{a:{id:'a'}}},closePopup(){},toast:x=>messages.push(x),txGet:async()=>undefined,console:{error(){}},download(){downloaded=true}};
  vm.createContext(context);vm.runInContext(extract('exportBackup'),context);
  await context.exportBackup();
  assert.equal(downloaded,false);
  assert.ok(messages.some(x=>x.includes('完全なバックアップを作れませんでした')));
});
