/** Allowlisted, CSRF-protected review API with versioned queue and private audit. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './types.js';
import type { ReviewAction, ReviewCorrection, ReviewStore } from './review-types.js';
type Authorize=(request:FastifyRequest,write?:boolean)=>
  Promise<{id:string;displayName:string}>;
const version={type:'integer',minimum:1,maximum:2147483647} as const;
const reason={type:'string',maxLength:1000} as const;
export function reviewRoutes(app:FastifyInstance,store:ReviewStore,authorize:Authorize){
 const guard=(write=false)=>async(req:FastifyRequest)=>{await authorize(req,write);};
 app.get('/api/v1/admin/catalog',{onRequest:guard()},async()=>store.adminCatalog());
 app.get<{Querystring:{status?:'pending'|'reviewed';unmatched?:string;limit?:string;cursor?:string}}>(
 '/api/v1/admin/submissions',{
  onRequest:guard(),
  schema:{querystring:{type:'object',additionalProperties:false,
   properties:{
    status:{type:'string',enum:['pending','reviewed']},
    unmatched:{type:'string',enum:['true']},
    limit:{type:'string',pattern:'^([1-9]|1[0-9]|20)$'},
    cursor:{type:'string',maxLength:1024},
   }}},
 },async req=>{
  const status=req.query.status??'pending';
  if(status==='reviewed'&&req.query.unmatched!==undefined)
   throw new ApiError(400,'Unmatched filter only applies to pending claims.');
  return store.queue(status,req.query.unmatched==='true',
   Number(req.query.limit??'20'),req.query.cursor);
 });
 app.get<{Params:{id:string}}>('/api/v1/admin/submissions/:id',{
  onRequest:guard(),
 },async req=>{
  const result=await store.detail(req.params.id);
  if(!result)throw new ApiError(404,'Submission not found.');
  return result;
 });
 const editSchema={
  body:{type:'object',additionalProperties:false,
   required:['expectedVersion','itemId','collectorName','collectedOn','hardcore','reason'],
   properties:{
    expectedVersion:version,itemId:version,
    collectorName:{type:'string',minLength:1,maxLength:80},
    collectedOn:{type:'string',pattern:'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'},
    hardcore:{type:'boolean'},reason,
   }},
 };
 app.patch<{Params:{id:string};Body:ReviewCorrection&{expectedVersion:number}}>(
  '/api/v1/admin/submissions/:id',{onRequest:guard(true),schema:editSchema},
  async req=>{
   const actor=await authorize(req,true);
   return store.mutate(req.params.id,req.body.expectedVersion,{
    itemId:req.body.itemId,collectorName:req.body.collectorName,
    collectedOn:req.body.collectedOn,hardcore:req.body.hardcore,
    reason:req.body.reason,
   },actor.id,actor.displayName);
  });
 for(const action of ['approve','reject','revoke'] as const){
  app.post<{Params:{id:string};Body:{expectedVersion:number;reason?:string}}>(
   '/api/v1/admin/submissions/:id/'+action,{
    onRequest:guard(true),
    schema:{body:{type:'object',additionalProperties:false,
     required:action==='approve'?['expectedVersion']:['expectedVersion','reason'],
     properties:{expectedVersion:version,...(action==='approve'?{}:{reason})}}},
   },async req=>{
    const actor=await authorize(req,true);
    const command:ReviewAction={
     expectedVersion:req.body.expectedVersion,
     action,...(action==='approve'?{}:{reason:req.body.reason}),
    };
    return store.mutate(req.params.id,command.expectedVersion,
     command,actor.id,actor.displayName);
   });
 }
}
},
    hardcore:{type:'boolean'},reason,
   }},
 };
 app.patch<{Params:{id:string};Body:ReviewCorrection&{expectedVersion:number}}>(
  '/api/v1/admin/submissions/:id',{onRequest:guard(true),schema:editSchema},
  async req=>{
   const actor=await authorize(req,true);
   return store.mutate(req.params.id,req.body.expectedVersion,{
    itemId:req.body.itemId,collectorName:req.body.collectorName,
    collectedOn:req.body.collectedOn,hardcore:req.body.hardcore,
    reason:req.body.reason,
   },actor.id,actor.displayName);
  });
 for(const action of ['approve','reject','revoke'] as const){
  app.post<{Params:{id:string};Body:{expectedVersion:number;reason?:string}}>(
   '/api/v1/admin/submissions/:id/'+action,{
    onRequest:guard(true),
    schema:{body:{type:'object',additionalProperties:false,
     required:action==='approve'?['expectedVersion']:['expectedVersion','reason'],
     properties:{expectedVersion:version,...(action==='approve'?{}:{reason})}}},
   },async req=>{
    const actor=await authorize(req,true);
    const command:ReviewAction={
     expectedVersion:req.body.expectedVersion,
     action,...(action==='approve'?{}:{reason:req.body.reason}),
    };
    return store.mutate(req.params.id,command.expectedVersion,
     command,actor.id,actor.displayName);
   });
 }
}
