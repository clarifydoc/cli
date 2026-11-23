import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { SalesforceEntityExtractor } from "./entities.js";
import { apexSpec } from "./index.js";
import { apexManifest } from "./manifest.js";
import { apexSource } from "./preprocess.js";

/** Platform namespaces and types: never a project class (`System.debug`, `Database.insert`, `new List<Club__c>()`). */
const APEX_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "System", "Database", "Schema", "Test", "Trigger", "Limits", "UserInfo", "Math", "JSON", "JSONGenerator", "JSONParser", "Url", "Type", "Pattern",
  "Matcher", "Crypto", "EncodingUtil", "Messaging", "ApexPages", "PageReference", "Savepoint", "RestContext", "RestRequest", "RestResponse",
  "Http", "HttpRequest", "HttpResponse", "Label", "Site", "Auth", "Cache", "ConnectApi", "Process", "Flow", "Approval", "EventBus", "Metadata",
  "Dom", "XmlStreamReader", "XmlStreamWriter", "TimeZone", "Comparable", "Queueable", "Schedulable", "Iterable", "Iterator", "Exception",
  "DmlException", "QueryException", "CalloutException", "SObject", "SObjectType", "SObjectField", "DescribeSObjectResult", "Id", "Blob", "Object",
  "String", "Integer", "Long", "Double", "Decimal", "Boolean", "Date", "Datetime", "Time", "List", "Set", "Map", "Database.Batchable",
  "Database.QueryLocator", "Database.SaveResult", "Database.UpsertResult", "Database.DeleteResult", "Database.Error", "Database.BatchableContext",
  "System.Callable", "Schedulable", "SchedulableContext", "QueueableContext", "StubProvider", "HttpCalloutMock", "Search", "Visualforce", "Wave", "Canvas",
]);

export const apexMeta: LanguagePluginMeta = {
  ...apexManifest,
  regexSpec: apexSpec,
  builtinTypes: APEX_BUILTINS,
  entities: new SalesforceEntityExtractor(),
  preprocess(rawSource) {
    return apexSource(rawSource);
  },
};
