// Development oracle: execute the pinned VS Code scope matcher and resolver.
// No production Go implementation is used to calculate expected styles.
import fs from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {inputs,writeJSON} from './inputs.mjs';
const {sources,out,assets}=inputs('style');
const base=path.join(sources,'vscode')+path.sep;
const compile=source=>stripTypeScriptTypes(source,{mode:'transform'});
const matcherSource=fs.readFileSync(base+'textMateScopeMatcher.ts','utf8');
const matcher=await import('data:text/javascript;base64,'+Buffer.from(compile(matcherSource)).toString('base64'));
const themeSource=fs.readFileSync(base+'colorThemeData.ts','utf8');
const helperSource=themeSource.slice(themeSource.indexOf('const noMatch ='),themeSource.indexOf('function readSemanticTokenRule'));
const {getScopeMatcher}=new Function('createMatchers',compile(helperSource)+';return {getScopeMatcher};')(matcher.createMatchers);
const tokenSource=fs.readFileSync(base+'tokenClassificationRegistry.ts','utf8');
const styleSource=tokenSource.slice(tokenSource.indexOf('export class TokenStyle'),tokenSource.indexOf('export type ProbeScope')).replace('export class TokenStyle','class TokenStyle').replace('export namespace TokenStyle','namespace TokenStyle');
const TokenStyle=new Function('Color',compile(styleSource)+';return TokenStyle;')({fromHex:hex=>hex.toUpperCase()});
const methodSource=themeSource.slice(themeSource.indexOf('public resolveScopes('),themeSource.indexOf('public defines('));
const ScopeProbe=new Function('getScopeMatcher','TokenStyle','types',compile('class Probe { constructor(rules) { this.themeTokenColors=rules;this.customTokenColors=[]; } '+methodSource+' }')+';return Probe;')(getScopeMatcher,TokenStyle,{isString:value=>typeof value==='string'});
const fallback={class:[['entity.name.type.class'],['support.class']],method:[['entity.name.function.member'],['support.function']],keyword:[['keyword.control']],property:[['variable.other.property']]};

const selectorMethod=tokenSource.slice(tokenSource.indexOf('public parseTokenSelector('),tokenSource.indexOf('public registerTokenStyleDefault('));
const parseClassifier=tokenSource.slice(tokenSource.indexOf('export function parseClassifierString('),tokenSource.indexOf('const tokenClassificationRegistry = createDefaultTokenClassificationRegistry()')).replaceAll('export ','');
const Registry=new Function(compile('const CHAR_LANGUAGE=58,CHAR_MODIFIER=46,TOKEN_TYPE_WILDCARD="*";'+parseClassifier+';class Registry { getTypeHierarchy(type){return [type];} '+selectorMethod+' }')+';return {Registry,parseClassifierString};')();
const registry=new Registry.Registry();
registry.getTokenStylingDefaultRules=()=>Object.entries(fallback).map(([type,scopes])=>({selector:registry.parseTokenSelector(type),defaults:{scopesToProbe:scopes}}));
const semanticMethods=themeSource.slice(themeSource.indexOf('private getTokenStyle('),themeSource.indexOf('public getTokenColorIndex('));
const SemanticProbe=new Function('getScopeMatcher','TokenStyle','types','tokenClassificationRegistry','parseClassifierString',compile('class SemanticProbe { constructor(theme,rules) { this.themeTokenColors=theme.tokenColors;this.customTokenColors=[];this.semanticTokenRules=rules;this.customSemanticTokenRules=[];this.type="dark";} '+methodSource+semanticMethods+' }')+';return SemanticProbe;')(getScopeMatcher,TokenStyle,{isString:value=>typeof value==='string'},registry,Registry.parseClassifierString);
const styleCases=JSON.parse(fs.readFileSync(path.join(sources,'semantic-style-cases.json'),'utf8'));
for(const item of styleCases){
 const rules=Object.entries(item.theme.semanticTokenColors).map(([selector,settings])=>({selector:registry.parseTokenSelector(selector),style:typeof settings==='string'?TokenStyle.fromSettings(settings,undefined):TokenStyle.fromSettings(settings.foreground,settings.fontStyle,settings.bold,settings.underline,settings.strikethrough,settings.italic)}));
 item.expected=new SemanticProbe(item.theme,rules).getTokenStyle(item.type,item.modifiers,item.language);
}
writeJSON(out,'upstream-semantic-style-cases.json',styleCases);

const results={};
for(const theme of ['one-dark-pro','one-light']){
 const data=JSON.parse(fs.readFileSync(path.join(assets,'themes',theme+'.json'),'utf8'));
 const probe=new ScopeProbe(data.tokenColors);
 results[theme]={semanticHighlighting:data.semanticHighlighting===true,styles:Object.fromEntries(Object.entries(fallback).map(([type,scopes])=>[type,probe.resolveScopes(scopes)]))};
}
writeJSON(out,'semantic-fallback-colors.json',{method:'unmodified scope matcher, getScopeMatcher, resolveScopes and TokenStyle.fromSettings extracted from pinned VS Code source; Color.fromHex normalized to uppercase hex for JSON',...results});
