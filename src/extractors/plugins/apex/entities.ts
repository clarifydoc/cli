import type { ClassInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";
import { elementText, withoutXmlComments } from "../shared/xml-scan.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";

/**
 * SObjects, read from SFDX source-format metadata (the `*-meta.xml` files the XML plugin hands over):
 *
 *   objects/Club__c/Club__c.object-meta.xml          → the entity (an older single-file object also lists `<fields>`)
 *   objects/Club__c/fields/Rating__c.field-meta.xml  → a column of Club__c
 *   <type>Lookup|MasterDetail</type> + <referenceTo>Club__c</referenceTo> → a many-to-one relation to Club__c
 *
 * A field file states one column and says which object holds it only by its folder, so per file it is a FRAGMENT
 * (a class decorated `sobject-fields`, no entity of its own); `reconcileProject` gathers the fragments onto the
 * object's entity — the object file's, or, when the project keeps only fields (a standard object it adds fields to),
 * the first fragment's. A standard object is an entity only where the project defines it or its fields.
 * Names are the API names as the metadata spells them; data rows naming one in another case are corrected to it.
 */

const METADATA_NS = "soap.sforce.com/2006/04/metadata";
const FRAGMENT = "sobject-fields";
const ORM = "salesforce";

/** Whether a file is SFDX object or field metadata (by name, then by its namespace). */
export function isSalesforceMetadata(relativePath: string, raw: string): boolean {
  return /\.(?:object|field)-meta\.xml$/i.test(relativePath) && raw.includes(METADATA_NS);
}

/** The object folder a metadata path sits in: `…/objects/Club__c/fields/X.field-meta.xml` → `Club__c`. */
function objectOfPath(path: string): string | null {
  return /(?:^|\/)objects\/([^/]+)\//.exec(path)?.[1] ?? null;
}

interface FieldDef { name: string; type: string | null; referenceTo: string | null; required: boolean; relationshipName: string | null }

function fieldDefOf(xml: string, fallbackName: string | null): FieldDef | null {
  const name = elementText(xml, "fullName") ?? fallbackName;
  if (!name) return null;
  const type = elementText(xml, "type");
  return { name, type, referenceTo: elementText(xml, "referenceTo"), relationshipName: elementText(xml, "relationshipName"), required: elementText(xml, "required") === "true" || type === "MasterDetail" };
}

function relationOf(object: string, f: FieldDef): EntityRelation | null {
  if (!f.referenceTo || (f.type !== "Lookup" && f.type !== "MasterDetail" && f.type !== "Hierarchy")) return null;
  return {
    fromEntity: object, fromField: f.name, toEntity: f.referenceTo, cardinality: "many-to-one",
    // The name a subquery of the parent reads the children by: `Players` is `Players__r` on a custom field.
    ...(f.relationshipName ? { inverseField: `${f.relationshipName}${/__c$/i.test(f.name) ? "__r" : ""}` } : {}),
    optional: !f.required, orm: ORM, confidence: "EXTRACTED",
  };
}

export class SalesforceEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["apex"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const path = ctx.analysis.filePath;
    if (!isSalesforceMetadata(path, ctx.sourceText)) return { entities: [], relations: [] };
    const xml = withoutXmlComments(ctx.sourceText);
    const fileName = /([^/]+)\.(?:object|field)-meta\.xml$/i.exec(path)?.[1] ?? null;
    const relations: EntityRelation[] = [];
    const column = (f: FieldDef): PropertyInfo => ({ ...this.column(f.name, f.type), ...(f.referenceTo ? { references: f.referenceTo } : {}) } as PropertyInfo);

    if (/\.field-meta\.xml$/i.test(path)) {
      const object = objectOfPath(path);
      const field = fieldDefOf(xml, fileName);
      if (!object || !field) return { entities: [], relations: [] };
      const rel = relationOf(object, field);
      if (rel) relations.push(rel);
      const fragment = this.entity({ name: object, orm: ORM, properties: [column(field)] });
      fragment.decorators = [FRAGMENT];
      return { entities: [fragment], relations };
    }

    const object = fileName ?? objectOfPath(path);
    if (!object) return { entities: [], relations: [] };
    const props: PropertyInfo[] = [{ ...this.column("Id", "Id"), primaryKey: true } as PropertyInfo];
    // An object file of the older format lists its fields inline.
    for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
      const f = fieldDefOf(m[1]!, null);
      if (!f) continue;
      props.push(column(f));
      const rel = relationOf(object, f);
      if (rel) relations.push(rel);
    }
    return { entities: [this.entity({ name: object, orm: ORM, properties: props, line: 1, endLine: xml.split("\n").length })], relations };
  }

  /** Fragments onto their object's entity; data rows' object names to the case the metadata spells. */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const apex = analyses.filter((a) => a.language === "apex");
    const hosts = new Map<string, ClassInfo>();
    const fragments: Array<{ file: FileAnalysis; cls: ClassInfo }> = [];
    for (const file of apex) {
      for (const cls of file.classes) {
        if (cls.decorators.includes(FRAGMENT)) fragments.push({ file, cls });
        else if (cls.decorators.includes("entity") && cls.decorators.includes(ORM) && !hosts.has(cls.name.toLowerCase())) hosts.set(cls.name.toLowerCase(), cls);
      }
    }
    for (const { file, cls } of fragments) {
      const host = hosts.get(cls.name.toLowerCase());
      if (!host) {
        // Fields of an object the project declares no file for: the first fragment becomes its entity.
        cls.decorators = ["entity", ORM];
        cls.properties = [{ ...this.column("Id", "Id"), primaryKey: true } as PropertyInfo, ...cls.properties];
        hosts.set(cls.name.toLowerCase(), cls);
        continue;
      }
      const have = new Set(host.properties.map((p) => p.name));
      for (const p of cls.properties) if (!have.has(p.name)) { have.add(p.name); host.properties.push(p); }
      file.classes = file.classes.filter((c) => c !== cls);
    }
    // A child relationship a subquery names: the lookup field of another object that declares it from the parent.
    const children = new Map<string, string | null>();
    for (const file of apex) {
      for (const r of file.entityRelations ?? []) {
        if (r.orm !== ORM || !r.inverseField) continue;
        const key = `${r.toEntity.toLowerCase()}\0${r.inverseField.toLowerCase()}`;
        // Two objects declaring one relationship name on a parent: no answer is a guess.
        const known = children.get(key);
        children.set(key, known === undefined || known === r.fromEntity ? r.fromEntity : null);
      }
    }
    for (const file of apex) {
      if (!file.dataSources.some((d) => d.viaRelationship)) continue;
      file.dataSources = file.dataSources.filter((d) => {
        if (!d.viaRelationship || d.entity) return true;
        const key = `${d.viaRelationship.parent.toLowerCase()}\0${d.viaRelationship.name.toLowerCase()}`;
        // The project's own lookups first; a standard object's own children are the platform's (`Account.Contacts`).
        const child = children.has(key) ? children.get(key) : STANDARD_CHILDREN.get(key);
        if (!child) return false;
        const declared = hosts.get(child.toLowerCase())?.name ?? child;
        d.entity = declared;
        d.target = declared;
        return true;
      });
    }
    if (hosts.size === 0) return;
    for (const file of apex) {
      for (const d of file.dataSources) {
        if (d.kind !== "database" || !d.entity) continue;
        const declared = hosts.get(d.entity.toLowerCase());
        if (declared && declared.name !== d.entity) { d.entity = declared.name; d.target = declared.name; }
      }
    }
  }
}

/**
 * The child relationships the platform declares on its standard objects — `(SELECT Id FROM Contacts)` on `Account`
 * reads `Contact` — which no project metadata states, keyed `parent\0relationship` in lower case. Only the
 * relationships Salesforce's object reference documents; a custom `__r` name is always the project's.
 */
const STANDARD_CHILDREN: ReadonlyMap<string, string> = (() => {
  const activity = { Tasks: "Task", Events: "Event", Notes: "Note", Attachments: "Attachment", ContentDocumentLinks: "ContentDocumentLink" };
  const byParent: Record<string, Record<string, string>> = {
    Account: { ...activity, Contacts: "Contact", Opportunities: "Opportunity", Cases: "Case", Contracts: "Contract", Orders: "Order", Assets: "Asset", ChildAccounts: "Account", AccountContactRelations: "AccountContactRelation", Entitlements: "Entitlement", WorkOrders: "WorkOrder" },
    Contact: { ...activity, Cases: "Case", AccountContactRelations: "AccountContactRelation", CampaignMembers: "CampaignMember", OpportunityContactRoles: "OpportunityContactRole" },
    Lead: { ...activity, CampaignMembers: "CampaignMember" },
    Opportunity: { ...activity, OpportunityLineItems: "OpportunityLineItem", OpportunityContactRoles: "OpportunityContactRole", Quotes: "Quote" },
    Case: { ...activity, CaseComments: "CaseComment", EmailMessages: "EmailMessage", TeamMembers: "CaseTeamMember" },
    Campaign: { ...activity, CampaignMembers: "CampaignMember" },
    Contract: { ...activity, Orders: "Order" },
    Order: { ...activity, OrderItems: "OrderItem" },
    Quote: { ...activity, QuoteLineItems: "QuoteLineItem" },
    Product2: { PricebookEntries: "PricebookEntry" },
    Pricebook2: { PricebookEntries: "PricebookEntry" },
    WorkOrder: { ...activity, WorkOrderLineItems: "WorkOrderLineItem" },
  };
  const out = new Map<string, string>();
  for (const [parent, rels] of Object.entries(byParent)) for (const [rel, child] of Object.entries(rels)) out.set(`${parent.toLowerCase()}\0${rel.toLowerCase()}`, child);
  return out;
})();
