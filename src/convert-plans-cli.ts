/** Explicit offline migration CLI. No default path and no daemon connection. */
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { Store, readPlanData } from "./store.ts";
import { convertPlans, updatePlanSummary } from "./convert-plans.ts";
import { verifyPlans } from "./verify-plans.ts";
import type { Snapshot as LegacySnapshot } from "./legacy-model.ts";

try {
  const {values}=parseArgs({options:{data:{type:"string"},report:{type:"string"},"dry-run":{type:"boolean"},"approved-head":{type:"string"}}});
  if(!values.data||!values.report)throw new Error("Usage: npm run convert:plans -- --data DIR --report FILE [--dry-run | --approved-head SHA]");
  const data=resolve(values.data), reportPath=resolve(values.report);
  // A report is output, never a board data file the dry run could overwrite.
  if(reportPath===data||reportPath.startsWith(data+"/"))throw new Error("--report must be outside the data directory");
  const loaded=await readPlanData(data);
  if(!loaded.legacy)throw new Error("Data already uses item plans; no conversion is needed");
  const source=loaded.snapshot as LegacySnapshot;
  if(!values["dry-run"]){
    if(!values["approved-head"])throw new Error("Live conversion requires --approved-head from the owner-approved dry run");
    const approved=parse(await readFile(reportPath,"utf8")) as {sourceHead?:unknown;errors?:unknown};
    if(approved.sourceHead!==values["approved-head"]||approved.sourceHead!==source.head)throw new Error("Approved dry-run report does not match the current data head");
    if(!Array.isArray(approved.errors)||approved.errors.length)throw new Error("Approved dry-run report has errors or lacks verification");
  }
  const result=convertPlans(source,{at:new Date().toISOString()});
  result.report.errors.push(...verifyPlans(source,result));
  updatePlanSummary(result.report,true);
  if(values["dry-run"])await writeFile(reportPath,stringify(result.report,{lineWidth:0,blockQuote:"literal"}));
  console.info(JSON.stringify({sourceHead:source.head,counts:result.report.counts,findings:result.report.findings.length,rewritePointers:result.report.rewritePointers.length,survey:result.report.survey,byCause:result.report.byCause,statusChanges:result.report.statusChanges.length,priorityChanges:result.report.priorityChanges.length,archiveChanges:result.report.archiveChanges.length,errors:result.report.errors.length,report:reportPath}));
  if(result.report.errors.length)throw new Error(result.report.errors.slice(0,10).join("\n")+(result.report.errors.length>10?`\n… ${result.report.errors.length-10} further errors in ${reportPath}`:""));
  if(!values["dry-run"]){const store=await Store.open(data,{planConversionHead:values["approved-head"]});console.info(`Converted in ${store.snapshot().head}`);}
} catch(error){console.error(error instanceof Error?error.message:error);process.exitCode=1;}
