import * as THREE from 'three';
const FT = .3048;
export async function createViewTools(scene, sun, hemisphere, render, model, setShadeSystem) {
  const response = await fetch('./assets/room-guide.json');
  if (!response.ok) throw new Error(`Room reference: HTTP ${response.status}`);
  const guide = await response.json();
  const state = { ids: false, square_grid: true, radial_grid: false, time_of_day: 15, areas: false, exterior_finish: 'stone', height_grid: false, wall_lengths:false, ring_awning:true, door_canopies:false };
  for(const [id,key] of [['ring-awning','ring_awning'],['door-canopies','door_canopies']]) {
    const control=document.getElementById(id);control.checked=state[key];setShadeSystem(key,state[key]);
    control.addEventListener('change',e=>{state[key]=e.target.checked;setShadeSystem(key,state[key]);render();});
  }
  function grid(vertices, color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({color, transparent:true, opacity, depthWrite:false}));
    scene.add(object); return object;
  }
  // Only two visual line batches. These never enter the collision octree.
  const square = [], radial = [];
  const segment = (v,x,y,u,w) => v.push(x*FT,.014,y*FT,u*FT,.014,w*FT);
  for(let n=-56;n<=56;n++) {
    const edge=Math.sqrt(56*56-n*n);
    segment(square,n,-edge,n,edge);segment(square,-edge,n,edge,n);
  }
  for(let r=1;r<=56;r++) {
    const count=Math.max(32,Math.ceil(2*Math.PI*r/.5));
    for(let j=0;j<count;j++) {
      const a=j/count*2*Math.PI,b=(j+1)/count*2*Math.PI;
      segment(radial,r*Math.cos(a),r*Math.sin(a),r*Math.cos(b),r*Math.sin(b));
    }
  }
  for(let a=0;a<360;a+=9)segment(radial,0,0,56*Math.cos(a*Math.PI/180),56*Math.sin(a*Math.PI/180));
  const squareGrid=grid(square,0x344a44,.25);
  const radialGrid=grid(radial,0x244e67,.40);radialGrid.visible=false;
  // All IDs share one small texture atlas and one draw call.
  const entries=[...guide.rooms,...guide.doors.filter(d=>d.status!=='closed')];
  const atlas=document.createElement('canvas');atlas.width=1024;atlas.height=Math.ceil(entries.length/8)*64;
  const ctx=atlas.getContext('2d');ctx.font='bold 38px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  const positions=[],uv=[],indices=[];
  entries.forEach((item,i)=>{
    const col=i%8,row=Math.floor(i/8);
    ctx.fillStyle=item.id[0]==='R'?'#173e2e':'#8b3e13';
    ctx.fillText(item.id,col*128+64,row*64+32);
    const [r,a]=item.label, angle=a*Math.PI/180;
    const labelRadius=r+(item.id[0]==='R'&&r>=26?1.6:0);
    const center=new THREE.Vector3(labelRadius*FT*Math.cos(angle),.021,-labelRadius*FT*Math.sin(angle));
    const width=(item.id[0]==='R'?2:1.5)*FT, height=width/2;
    // Text baseline is tangential; top points away from the garden.
    const right=new THREE.Vector3(Math.sin(angle),0,Math.cos(angle));
    const up=new THREE.Vector3(Math.cos(angle),0,-Math.sin(angle));
    for(const [x,y] of [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]])positions.push(...center.clone().addScaledVector(right,x*width).addScaledVector(up,y*height).toArray());
    const u=col/8,v=1-(row+1)*64/atlas.height,du=1/8,dv=64/atlas.height;
    uv.push(u,v,u+du,v,u+du,v+dv,u,v+dv);indices.push(i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3);
  });
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);
  const texture=new THREE.CanvasTexture(atlas);texture.colorSpace=THREE.SRGBColorSpace;
  const ids=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false,side:THREE.DoubleSide}));
  ids.visible=false;scene.add(ids);
  for(const [id,key,object] of [['id-labels','ids',ids],['square-grid','square_grid',squareGrid],['radial-grid','radial_grid',radialGrid]]) {
    document.getElementById(id).addEventListener('change',e=>{state[key]=object.visible=e.target.checked;render();});
  }
  // Area text uses a second single atlas, independently controlled from names and IDs.
  const areaCanvas=document.createElement('canvas');areaCanvas.width=2048;const areaRows=Math.ceil(guide.rooms.length/8);areaCanvas.height=areaRows*64;
  const ac=areaCanvas.getContext('2d');ac.font='bold 30px sans-serif';ac.textAlign='center';ac.textBaseline='middle';ac.fillStyle='#244e67';
  const ap=[],au=[],ai=[];
  guide.rooms.forEach((room,i)=>{
    ac.fillText(`≈ ${Math.round(room.area_sqft)} sq ft`,(i%8)*256+128,Math.floor(i/8)*64+32);
    const [r,a]=room.label,angle=a*Math.PI/180;
    const radius=r+(r<26 ? -.9 : 2.6);
    const c=new THREE.Vector3(radius*FT*Math.cos(angle),.023,-radius*FT*Math.sin(angle));
    const right=new THREE.Vector3(Math.sin(angle),0,Math.cos(angle)),up=new THREE.Vector3(Math.cos(angle),0,-Math.sin(angle));
    for(const [x,y] of [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]])ap.push(...c.clone().addScaledVector(right,x*3.1*FT).addScaledVector(up,y*.78*FT).toArray());
    const u=(i%8)/8,v=1-(Math.floor(i/8)+1)/areaRows;au.push(u,v,u+1/8,v,u+1/8,v+1/areaRows,u,v+1/areaRows);ai.push(i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3);
  });
  const ag=new THREE.BufferGeometry();ag.setAttribute('position',new THREE.Float32BufferAttribute(ap,3));ag.setAttribute('uv',new THREE.Float32BufferAttribute(au,2));ag.setIndex(ai);
  const at=new THREE.CanvasTexture(areaCanvas);at.colorSpace=THREE.SRGBColorSpace;
  const areas=new THREE.Mesh(ag,new THREE.MeshBasicMaterial({map:at,transparent:true,depthWrite:false,side:THREE.DoubleSide}));areas.visible=false;scene.add(areas);
  document.querySelector('#area-labels').addEventListener('change',e=>{state.areas=areas.visible=e.target.checked;render();});
  function finish(value) {
    state.exterior_finish=value;
    model.traverse(o=>{if(o.userData.group==='15')o.visible=o.userData.finish_option===value;});
    render();
  }
  // The rock/stone finish is the owner's default walkthrough presentation.
  // The select's initial value and the actual visible mesh must agree, or the
  // first render would silently switch back to the plain shell.
  document.querySelector('#exterior-finish').addEventListener('change',e=>finish(e.target.value));finish('stone');
  const heightResponse=await fetch('./assets/height-grid.json');
  if(!heightResponse.ok)throw new Error('Height grid could not load');
  const heightSource=await heightResponse.json(),heightVertices=[];
  for(let i=0;i<heightSource.length;i+=3)heightVertices.push(heightSource[i]*FT,heightSource[i+2]*FT,-heightSource[i+1]*FT);
  for(let z=1;z<=14;z++)for(const r of [35-Math.sqrt(14.72**2-z*z),35+Math.sqrt(14.72**2-z*z)]) {
    for(let a=0;a<360;a++){
      const p=a*Math.PI/180,q=(a+1)*Math.PI/180;
      heightVertices.push(r*FT*Math.cos(p),z*FT,-r*FT*Math.sin(p),r*FT*Math.cos(q),z*FT,-r*FT*Math.sin(q));
    }
  }
  const heights=grid(heightVertices,0x386787,.38);heights.visible=false;
  document.querySelector('#height-grid').addEventListener('change',e=>{state.height_grid=heights.visible=e.target.checked;render();});
  const edgeResponse=await fetch('./assets/edge-labels.json');
  if(!edgeResponse.ok)throw new Error('Wall lengths could not load');
  const edgeData=await edgeResponse.json(),edgeRows=Math.ceil(edgeData.length/8);
  const edgeCanvas=document.createElement('canvas');edgeCanvas.width=2048;edgeCanvas.height=edgeRows*64;
  const ec=edgeCanvas.getContext('2d');ec.font='bold 29px sans-serif';ec.textAlign='center';ec.textBaseline='middle';ec.fillStyle='#714622';
  const ep=[],eu=[],ei=[];
  edgeData.forEach((e,i)=>{
    ec.fillText(e.text,(i%8)*256+128,Math.floor(i/8)*64+32);
    const c=new THREE.Vector3(e.position_ft[0]*FT,e.position_ft[2]*FT,-e.position_ft[1]*FT);
    const right=new THREE.Vector3(e.right[0],0,-e.right[1]),up=new THREE.Vector3(e.up[0],0,-e.up[1]);
    for(const [x,y] of [[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]])ep.push(...c.clone().addScaledVector(right,x*e.width_ft*FT).addScaledVector(up,y*.48*FT).toArray());
    const u=(i%8)/8,v=1-(Math.floor(i/8)+1)/edgeRows;eu.push(u,v,u+1/8,v,u+1/8,v+1/edgeRows,u,v+1/edgeRows);ei.push(i*4,i*4+1,i*4+2,i*4,i*4+2,i*4+3);
  });
  const eg=new THREE.BufferGeometry();eg.setAttribute('position',new THREE.Float32BufferAttribute(ep,3));eg.setAttribute('uv',new THREE.Float32BufferAttribute(eu,2));eg.setIndex(ei);
  const et=new THREE.CanvasTexture(edgeCanvas);et.colorSpace=THREE.SRGBColorSpace;
  const edgeLabels=new THREE.Mesh(eg,new THREE.MeshBasicMaterial({map:et,transparent:true,depthWrite:false,side:THREE.DoubleSide}));edgeLabels.visible=false;scene.add(edgeLabels);
  document.querySelector('#wall-lengths').addEventListener('change',e=>{state.wall_lengths=edgeLabels.visible=e.target.checked;render();});
  function setTime(value) {
    state.time_of_day=Number(value);
    const angle=(state.time_of_day-6)*Math.PI/12,day=Math.max(0,Math.sin(angle));
    sun.position.set(Math.cos(angle)*32,Math.sin(angle)*32,12);
    sun.intensity=3.2*Math.sqrt(day);sun.visible=day>0;
    hemisphere.intensity=.28+1.82*Math.sqrt(day);
    scene.environmentIntensity=.12+.2*day;sun.shadow.needsUpdate=true;
    const sky=new THREE.Color('#172635').lerp(new THREE.Color('#bfd4dc'),Math.sqrt(day));
    scene.background.copy(sky);scene.fog.color.copy(sky);
    const minutes=Math.round(state.time_of_day*60)%1440;
    document.querySelector('#clock').textContent=`${Math.floor(minutes/60)%12||12}:${String(minutes%60).padStart(2,'0')} ${minutes<720?'am':'pm'}`;
    document.querySelector('#time-of-day').setAttribute('aria-valuetext',document.querySelector('#clock').textContent);
    render();
  }
  document.querySelector('#time-of-day').addEventListener('input',e=>setTime(e.target.value));setTime(15);
  function currentRoom(x,z) {
    const radius=Math.hypot(x,z)/FT,angle=(Math.atan2(-z,x)*180/Math.PI+360)%360;
    if(radius>56){const half=Math.sqrt(43560)/2*FT;return Math.abs(x)<=half&&Math.abs(z)<=half ? guide.rooms.find(r=>r.id==='R35') : null;}
    if(radius>=20&&radius<(guide.hallway?.wall_center_ft||26))return guide.rooms.find(r=>r.id==='R29');
    // Chord partitions at R38 bow inward relative to the nominal circle.
    return guide.rooms.find(r=>{
      const a=angle<r.a?angle+360:angle;
      if(a<r.a||a>=r.b)return false;
      let ri=r.ri,ro=r.ro;
      const chord=38*Math.cos(9*Math.PI/180)/Math.cos((a-(r.a+r.b)/2)*Math.PI/180);
      if(r.split==='inside')ro=chord;if(r.split==='outside')ri=chord;
      return radius>=ri&&radius<ro;
    })||null;
  }
  return {state,currentRoom,counts:{rooms:guide.rooms.length,doors:guide.doors.filter(d=>d.status!=='closed').length,area_labels:guide.rooms.length,wall_edge_labels:edgeData.length,overlay_draw_calls:6}};
}
