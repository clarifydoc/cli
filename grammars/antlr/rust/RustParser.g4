/*
Copyright (c) 2010 The Rust Project Developers
Copyright (c) 2020-2022 Student Main

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next paragraph) shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

// $antlr-format alignTrailingComments true, columnLimit 150, minEmptyLines 1, maxEmptyLinesToKeep 1, reflowComments false, useTab false
// $antlr-format allowShortRulesOnASingleLine false, allowShortBlocksOnASingleLine true, alignSemicolons hanging, alignColons hanging

parser grammar RustParser;

// Insert here @header for C++ parser.
@header { import { RustParserBase } from "./RustParserBase.js"; }

options
{
    tokenVocab = RustLexer;
    superClass = RustParserBase;
}

// entry point
// 4
crate
    : innerAttribute* item* EOF
    ;

// 3
macroInvocation
    : simplePath NOT delimTokenTree
    ;

delimTokenTree
    : LPAREN tokenTree* RPAREN
    | LSQUAREBRACKET tokenTree* RSQUAREBRACKET
    | LCURLYBRACE tokenTree* RCURLYBRACE
    ;

tokenTree
    : tokenTreeToken+
    | delimTokenTree
    ;

tokenTreeToken
    : macroIdentifierLikeToken
    | macroLiteralToken
    | macroPunctuationToken
    | macroRepOp
    | DOLLAR
    ;

macroInvocationSemi
    : simplePath NOT LPAREN tokenTree* RPAREN SEMI
    | simplePath NOT LSQUAREBRACKET tokenTree* RSQUAREBRACKET SEMI
    | simplePath NOT LCURLYBRACE tokenTree* RCURLYBRACE
    ;

// 3.1
macroRulesDefinition
    : KW_MACRORULES NOT identifier macroRulesDef
    ;

macroRulesDef
    : LPAREN macroRules RPAREN SEMI
    | LSQUAREBRACKET macroRules RSQUAREBRACKET SEMI
    | LCURLYBRACE macroRules RCURLYBRACE
    ;

macroRules
    : macroRule (SEMI macroRule)* SEMI?
    ;

macroRule
    : macroMatcher FATARROW macroTranscriber
    ;

macroMatcher
    : LPAREN macroMatch* RPAREN
    | LSQUAREBRACKET macroMatch* RSQUAREBRACKET
    | LCURLYBRACE macroMatch* RCURLYBRACE
    ;

macroMatch
    : macroMatchToken+
    | macroMatcher
    // A keyword names a metavariable too (`$type:ty`). [ClarifyDoc addition]
    | DOLLAR (identifier | keyword | KW_SELFVALUE) COLON macroFragSpec
    | DOLLAR LPAREN macroMatch+ RPAREN macroRepSep? macroRepOp
    ;

macroMatchToken
    : macroIdentifierLikeToken
    | macroLiteralToken
    | macroPunctuationToken
    | macroRepOp
    ;

macroFragSpec
    : identifier // do validate here is wasting token
    ;

macroRepSep
    : macroIdentifierLikeToken
    | macroLiteralToken
    | macroPunctuationToken
    | DOLLAR
    ;

macroRepOp
    : STAR
    | PLUS
    | QUESTION
    ;

macroTranscriber
    : delimTokenTree
    ;

//configurationPredicate
// : configurationOption | configurationAll | configurationAny | configurationNot ; configurationOption: identifier (
// EQ (STRING_LITERAL | RAW_STRING_LITERAL))?; configurationAll: 'all' LPAREN configurationPredicateList? RPAREN;
// configurationAny: 'any' LPAREN configurationPredicateList? RPAREN; configurationNot: 'not' LPAREN configurationPredicate RPAREN;

//configurationPredicateList
// : configurationPredicate (COMMA configurationPredicate)* COMMA? ; cfgAttribute: 'cfg' LPAREN configurationPredicate RPAREN;
// cfgAttrAttribute: 'cfg_attr' LPAREN configurationPredicate COMMA cfgAttrs? RPAREN; cfgAttrs: attr (COMMA attr)* COMMA?;

// 6
item
    : outerAttribute* (visItem | macroItem)
    ;

visItem
    : visibility? (
        module
        | externCrate
        | useDeclaration
        | function_
        | typeAlias
        | struct_
        | enumeration
        | union_
        | constantItem
        | staticItem
        | trait_
        | implementation
        | externBlock
    )
    ;

macroItem
    : macroInvocationSemi
    | macroRulesDefinition
    ;

// 6.1
module
    : KW_UNSAFE? KW_MOD identifier (SEMI | LCURLYBRACE innerAttribute* item* RCURLYBRACE)
    ;

// 6.2
externCrate
    : KW_EXTERN KW_CRATE crateRef asClause? SEMI
    ;

crateRef
    : identifier
    | KW_SELFVALUE
    ;

asClause
    : KW_AS (identifier | UNDERSCORE)
    ;

// 6.3
useDeclaration
    : KW_USE useTree SEMI
    ;

useTree
    : (simplePath? PATHSEP)? (STAR | LCURLYBRACE ( useTree (COMMA useTree)* COMMA?)? RCURLYBRACE)
    | simplePath (KW_AS (identifier | UNDERSCORE))?
    ;

// 6.4
function_
    : functionQualifiers KW_FN identifier genericParams? LPAREN functionParameters? RPAREN functionReturnType? whereClause? (
        blockExpression
        | SEMI
    )
    ;

functionQualifiers
    : KW_CONST? KW_ASYNC? KW_UNSAFE? (KW_EXTERN abi?)?
    ;

abi
    : STRING_LITERAL
    | RAW_STRING_LITERAL
    ;

functionParameters
    : selfParam COMMA?
    | (selfParam COMMA)? functionParam (COMMA functionParam)* COMMA?
    ;

selfParam
    : outerAttribute* (shorthandSelf | typedSelf)
    ;

shorthandSelf
    : (AND lifetime?)? KW_MUT? KW_SELFVALUE
    ;

typedSelf
    : KW_MUT? KW_SELFVALUE COLON type_
    ;

functionParam
    : outerAttribute* (functionParamPattern | DOTDOTDOT | type_)
    ;

functionParamPattern
    : pattern COLON (type_ | DOTDOTDOT)
    ;

functionReturnType
    : RARROW type_
    ;

// 6.5
// An associated type may carry bounds (`type Error: SinkError;`). [ClarifyDoc addition]
typeAlias
    : KW_TYPE identifier genericParams? (COLON typeParamBounds?)? whereClause? (EQ type_ whereClause?)? SEMI
    ;

// 6.6
struct_
    : structStruct
    | tupleStruct
    ;

structStruct
    : KW_STRUCT identifier genericParams? whereClause? (LCURLYBRACE structFields? RCURLYBRACE | SEMI)
    ;

tupleStruct
    : KW_STRUCT identifier genericParams? LPAREN tupleFields? RPAREN whereClause? SEMI
    ;

structFields
    : structField (COMMA structField)* COMMA?
    ;

structField
    : outerAttribute* visibility? identifier COLON type_
    ;

tupleFields
    : tupleField (COMMA tupleField)* COMMA?
    ;

tupleField
    : outerAttribute* visibility? type_
    ;

// 6.7
enumeration
    : KW_ENUM identifier genericParams? whereClause? LCURLYBRACE enumItems? RCURLYBRACE
    ;

enumItems
    : enumItem (COMMA enumItem)* COMMA?
    ;

enumItem
    : outerAttribute* visibility? identifier (
        enumItemTuple
        | enumItemStruct
        | enumItemDiscriminant
    )?
    ;

enumItemTuple
    : LPAREN tupleFields? RPAREN
    ;

enumItemStruct
    : LCURLYBRACE structFields? RCURLYBRACE
    ;

enumItemDiscriminant
    : EQ expression
    ;

// 6.8
union_
    : KW_UNION identifier genericParams? whereClause? LCURLYBRACE structFields RCURLYBRACE
    ;

// 6.9
constantItem
    : KW_CONST (identifier | UNDERSCORE) COLON type_ (EQ expression)? SEMI
    ;

// 6.10
staticItem
    : KW_STATIC KW_MUT? identifier COLON type_ (EQ expression)? SEMI
    ;

// 6.11
trait_
    : KW_UNSAFE? KW_TRAIT identifier genericParams? (COLON typeParamBounds?)? whereClause? LCURLYBRACE innerAttribute* associatedItem* RCURLYBRACE
    ;

// 6.12
implementation
    : inherentImpl
    | traitImpl
    ;

inherentImpl
    : KW_IMPL genericParams? type_ whereClause? LCURLYBRACE innerAttribute* associatedItem* RCURLYBRACE
    ;

traitImpl
    : KW_UNSAFE? KW_IMPL genericParams? NOT? typePath KW_FOR type_ whereClause? LCURLYBRACE innerAttribute* associatedItem* RCURLYBRACE
    ;

// 6.13
externBlock
    : KW_UNSAFE? KW_EXTERN abi? LCURLYBRACE innerAttribute* externalItem* RCURLYBRACE
    ;

externalItem
    : outerAttribute* (macroInvocationSemi | visibility? ( staticItem | function_))
    ;

// 6.14
genericParams
    : LT ((genericParam COMMA)* genericParam COMMA?)? GT
    ;

genericParam
    : outerAttribute* (lifetimeParam | typeParam | constParam)
    ;

lifetimeParam
    : outerAttribute? LIFETIME_OR_LABEL (COLON lifetimeBounds)?
    ;

typeParam
    : outerAttribute? identifier (COLON typeParamBounds?)? (EQ type_)?
    ;

// `const N: usize = 3`: a default (Rust 1.59). [ClarifyDoc addition]
constParam
    : KW_CONST identifier COLON type_ (EQ (blockExpression | identifier | MINUS? literalExpression))?
    ;

whereClause
    : KW_WHERE (whereClauseItem COMMA)* whereClauseItem?
    ;

whereClauseItem
    : lifetimeWhereClauseItem
    | typeBoundWhereClauseItem
    ;

lifetimeWhereClauseItem
    : lifetime COLON lifetimeBounds
    ;

typeBoundWhereClauseItem
    : forLifetimes? type_ COLON typeParamBounds?
    ;

forLifetimes
    : KW_FOR genericParams
    ;

// 6.15
associatedItem
    : outerAttribute* (macroInvocationSemi | visibility? ( typeAlias | constantItem | function_))
    ;

// 7
innerAttribute
    : POUND NOT LSQUAREBRACKET attr RSQUAREBRACKET
    ;

outerAttribute
    : POUND LSQUAREBRACKET attr RSQUAREBRACKET
    ;

// `#[unsafe(no_mangle)]` (Rust 2024). [ClarifyDoc addition]
attr
    : simplePath attrInput?
    | KW_UNSAFE LPAREN attr RPAREN
    ;

// `#[doc = include_str!("x.md")]`: an attribute's value is an expression (Rust 1.54). [ClarifyDoc change]
attrInput
    : delimTokenTree
    | EQ expression
    ;

//metaItem
// : simplePath ( EQ literalExpression //w | LPAREN metaSeq RPAREN )? ; metaSeq: metaItemInner (COMMA metaItemInner)* COMMA?;
// metaItemInner: metaItem | literalExpression; // w

//metaWord: identifier; metaNameValueStr: identifier EQ ( STRING_LITERAL | RAW_STRING_LITERAL); metaListPaths:
// identifier LPAREN ( simplePath (COMMA simplePath)* COMMA?)? RPAREN; metaListIdents: identifier LPAREN ( identifier (COMMA
// identifier)* COMMA?)? RPAREN; metaListNameValueStr : identifier LPAREN (metaNameValueStr ( COMMA metaNameValueStr)* COMMA?)? RPAREN
// ;

// 8
// In a block, `foo!(…);` is an expression statement (so `write!(f, "x")?;` parses); only a braced macro, which
// needs no `;`, is a statement of its own. Upstream also read every `foo!(…);` as an item and as a macro
// statement, so each was ambiguous to its `;`. [ClarifyDoc change]
statement
    : SEMI
    | outerAttribute* (visItem | macroRulesDefinition)
    | letStatement
    | outerAttribute* simplePath NOT LCURLYBRACE tokenTree* RCURLYBRACE
    ;

// `let Some(x) = y else { return };` (Rust 1.65). [ClarifyDoc addition]
letStatement
    : outerAttribute* KW_LET patternNoTopAlt (COLON type_)? (EQ expression (KW_ELSE blockExpression)?)? SEMI
    ;

// A block-like statement may go on with `.`/`?` steps, as rustc allows (`match x { … }.unwrap()`,
// `if a { x } else { y }.map_err(f)?`), and ends at anything else. [ClarifyDoc change]

// After its first `.`/`?` step the statement is an expression to its end (`unsafe { b }.header.start = x;`).
blockTail
    : blockStep blockPostfix* blockOperation?
    ;

blockStep
    : DOT pathExprSegment LPAREN callParams? RPAREN
    | DOT identifier
    | DOT tupleIndex
    | DOT KW_AWAIT
    | QUESTION
    ;

blockPostfix
    : blockStep
    | LSQUAREBRACKET expression RSQUAREBRACKET
    | LPAREN callParams? RPAREN
    ;

blockOperation
    : (EQ | compoundAssignOperator | comparisonOperator | ANDAND | OROR | PLUS | MINUS | STAR | SLASH | PERCENT | AND | OR | CARET | shl | shr | DOTDOT | DOTDOTEQ) expression
    | KW_AS castType
    ;

// 8.2
expression
    : outerAttribute+ expression                                     # AttributedExpression // technical, remove left recursive
    | literalExpression                                              # LiteralExpression_
    | pathExpression                                                 # PathExpression_
    | expression DOT pathExprSegment LPAREN callParams? RPAREN       # MethodCallExpression          // 8.2.10
    | expression DOT identifier                                      # FieldExpression               // 8.2.11
    | expression DOT tupleIndex                                      # TupleIndexingExpression       // 8.2.7
    | expression DOT KW_AWAIT                                        # AwaitExpression               // 8.2.18
    | expression LPAREN callParams? RPAREN                           # CallExpression                // 8.2.9
    | expression LSQUAREBRACKET expression RSQUAREBRACKET            # IndexExpression               // 8.2.6
    | expression QUESTION                                            # ErrorPropagationExpression    // 8.2.4
    | (AND | ANDAND) KW_MUT? expression                              # BorrowExpression              // 8.2.4
    // `&raw const x`, `&raw mut x` (Rust 1.82). [ClarifyDoc addition]
    | (AND | ANDAND) identifier (KW_CONST | KW_MUT) expression       # RawBorrowExpression
    | STAR expression                                                # DereferenceExpression         // 8.2.4
    | (MINUS | NOT) expression                                         # NegationExpression            // 8.2.4
    | expression KW_AS castType                                      # TypeCastExpression            // 8.2.4
    | expression (STAR | SLASH | PERCENT) expression                  # ArithmeticOrLogicalExpression // 8.2.4
    | expression (PLUS | MINUS) expression                            # ArithmeticOrLogicalExpression // 8.2.4
    | expression (shl | shr) expression                              # ArithmeticOrLogicalExpression // 8.2.4
    | expression AND expression                                      # ArithmeticOrLogicalExpression // 8.2.4
    | expression CARET expression                                    # ArithmeticOrLogicalExpression // 8.2.4
    | expression OR expression                                       # ArithmeticOrLogicalExpression // 8.2.4
    | expression comparisonOperator expression                       # ComparisonExpression          // 8.2.4
    | expression ANDAND expression                                   # LazyBooleanExpression         // 8.2.4
    | expression OROR expression                                     # LazyBooleanExpression         // 8.2.4
    | expression DOTDOT expression?                                  # RangeExpression               // 8.2.14
    | DOTDOT expression?                                             # RangeExpression               // 8.2.14
    | DOTDOTEQ expression                                            # RangeExpression               // 8.2.14
    | expression DOTDOTEQ expression                                 # RangeExpression               // 8.2.14
    | expression EQ expression                                       # AssignmentExpression          // 8.2.4
    | expression compoundAssignOperator expression                   # CompoundAssignmentExpression  // 8.2.4
    | KW_CONTINUE LIFETIME_OR_LABEL? expression?                     # ContinueExpression            // 8.2.13
    | KW_BREAK LIFETIME_OR_LABEL? expression?                        # BreakExpression               // 8.2.13
    | KW_RETURN expression?                                          # ReturnExpression              // 8.2.17
    | LPAREN innerAttribute* expression RPAREN                       # GroupedExpression             // 8.2.5
    | LSQUAREBRACKET innerAttribute* arrayElements? RSQUAREBRACKET   # ArrayExpression               // 8.2.6
    | LPAREN innerAttribute* tupleElements? RPAREN                   # TupleExpression               // 8.2.7
    // A struct literal is the braced form only: `Foo(x)` reads as a call and `Foo` as a path, as rustc reads them,
    // and an enum variant is one of the three. Upstream's tuple, unit and enum-variant expressions had exactly
    // those shapes, so every call and path was ambiguous. [ClarifyDoc change]
    | structExpression                                               # StructExpression_             // 8.2.8
    // `_ = f()`: destructuring assignment to `_` (Rust 1.59). [ClarifyDoc addition]
    | UNDERSCORE                                                     # UnderscoreExpression
    | closureExpression                                              # ClosureExpression_            // 8.2.12
    | expressionWithBlock                                            # ExpressionWithBlock_
    | macroInvocation                                                # MacroInvocationAsExpression
    ;

// An expression in statement position: the same expression, but never one whose leftmost operand is block-like
// (`match`, `if`, `loop`, `{ }`) — as rustc reads it, such a statement ends at its block (`match x {} - 1` is two
// statements). Shared with `expression`, every block-like statement could also be a block's tail value, and
// prediction read the whole block, and every block inside it, to choose. Its alternatives mirror `expression`'s.
// [ClarifyDoc addition]
statementExpression
    : outerAttribute+ statementExpression
    | literalExpression
    | pathExpression
    | statementExpression DOT pathExprSegment LPAREN callParams? RPAREN
    | statementExpression DOT identifier
    | statementExpression DOT tupleIndex
    | statementExpression DOT KW_AWAIT
    | statementExpression LPAREN callParams? RPAREN
    | statementExpression LSQUAREBRACKET expression RSQUAREBRACKET
    | statementExpression QUESTION
    | (AND | ANDAND) KW_MUT? expression
    | (AND | ANDAND) identifier (KW_CONST | KW_MUT) expression
    | STAR expression
    | (MINUS | NOT) expression
    | statementExpression KW_AS castType
    | statementExpression (STAR | SLASH | PERCENT) expression
    | statementExpression (PLUS | MINUS) expression
    | statementExpression (shl | shr) expression
    | statementExpression AND expression
    | statementExpression CARET expression
    | statementExpression OR expression
    | statementExpression comparisonOperator expression
    | statementExpression ANDAND expression
    | statementExpression OROR expression
    | statementExpression DOTDOT expression?
    | DOTDOT expression?
    | DOTDOTEQ expression
    | statementExpression DOTDOTEQ expression
    | statementExpression EQ expression
    | statementExpression compoundAssignOperator expression
    | KW_CONTINUE LIFETIME_OR_LABEL? expression?
    | KW_BREAK LIFETIME_OR_LABEL? expression?
    | KW_RETURN expression?
    | LPAREN innerAttribute* expression RPAREN
    | LSQUAREBRACKET innerAttribute* arrayElements? RSQUAREBRACKET
    | LPAREN innerAttribute* tupleElements? RPAREN
    | structExpression
    | UNDERSCORE
    | closureExpression
    | macroInvocation
    ;


// A cast's type has rules of its own. Shared with `typeNoBounds`, a cast let every type be followed by `<` (the
// comparison in `x as T < y`, which rustc rejects anyway), so after each type name SLL prediction read on to
// tell generic arguments from a comparison. [ClarifyDoc change]
castType
    : castTypePath
    | STAR (KW_CONST | KW_MUT) castType
    | (AND | ANDAND) lifetime? KW_MUT? (KW_DYN castTypePath | castType)
    | LPAREN (type_ (COMMA type_)* COMMA?)? RPAREN
    | LSQUAREBRACKET castType (SEMI expression)? RSQUAREBRACKET
    | UNDERSCORE
    | forLifetimes? functionTypeQualifiers KW_FN LPAREN functionParametersMaybeNamedVariadic? RPAREN (RARROW castType)?
    ;

castTypePath
    : PATHSEP? castTypeSegment (PATHSEP castTypeSegment)*
    ;

castTypeSegment
    : (identifier | KW_SELFTYPE | KW_SELFVALUE | KW_CRATE | KW_SUPER) (PATHSEP? genericArgs | LPAREN (type_ (COMMA type_)* COMMA?)? RPAREN (RARROW castType)?)?
    ;

comparisonOperator
    : EQEQ
    | NE
    | GT
    | LT
    | GE
    | LE
    ;

compoundAssignOperator
    : PLUSEQ
    | MINUSEQ
    | STAREQ
    | SLASHEQ
    | PERCENTEQ
    | ANDEQ
    | OREQ
    | CARETEQ
    | SHLEQ
    | SHREQ
    ;

expressionWithBlock
    : outerAttribute+ expressionWithBlock // technical
    | blockExpression
    // `const { … }` (Rust 1.79). [ClarifyDoc addition]
    | KW_CONST blockExpression
    | asyncBlockExpression
    | unsafeBlockExpression
    | loopExpression
    | ifExpression
    | matchExpression
    ;

// 8.2.1
literalExpression
    : CHAR_LITERAL
    | STRING_LITERAL
    | RAW_STRING_LITERAL
    | BYTE_LITERAL
    | BYTE_STRING_LITERAL
    | RAW_BYTE_STRING_LITERAL
    | INTEGER_LITERAL
    | FLOAT_LITERAL
    | KW_TRUE
    | KW_FALSE
    ;

// 8.2.2
pathExpression
    : pathInExpression
    | qualifiedPathInExpression
    ;

// 8.2.3
blockExpression
    : LCURLYBRACE innerAttribute* statements? RCURLYBRACE
    ;

// Statements, an expression statement read once: its `;` says whether more follow, and its absence that it is
// the block's value. Upstream's `statement+ expression?` read each expression twice to learn which it was.
// [ClarifyDoc change]
statements
    : statement+ statementsTail?
    | statementsTail
    ;

// An expression statement and the statements after it. A block-like statement needs no `;` unless a `.`/`?`
// step goes on from it; after a step, `;` or the block's end follows, so nothing a later statement starts with
// can be read as more of the expression.
statementsTail
    : statementExpression (SEMI statements?)?
    | expressionWithBlock (blockTail (SEMI statements?)? | SEMI? statements?)
    ;

asyncBlockExpression
    : KW_ASYNC KW_MOVE? blockExpression
    ;

unsafeBlockExpression
    : KW_UNSAFE blockExpression
    ;

// 8.2.6
arrayElements
    : expression (COMMA expression)* COMMA?
    | expression SEMI expression
    ;

// 8.2.7
tupleElements
    : (expression COMMA)+ expression?
    ;

tupleIndex
    : INTEGER_LITERAL
    ;

// 8.2.8
structExpression
    : structExprStruct
    ;

structExprStruct
    : pathInExpression LCURLYBRACE innerAttribute* (structExprFields | structBase)? RCURLYBRACE
    ;

structExprFields
    : structExprField (COMMA structExprField)* (COMMA structBase | COMMA?)
    ;

// outerAttribute here is not in doc
structExprField
    : outerAttribute* (identifier | (identifier | tupleIndex) COLON expression)
    ;

structBase
    : DOTDOT expression
    ;

structExprTuple
    : pathInExpression LPAREN innerAttribute* (expression ( COMMA expression)* COMMA?)? RPAREN
    ;

structExprUnit
    : pathInExpression
    ;

enumerationVariantExpression
    : enumExprStruct
    | enumExprTuple
    | enumExprFieldless
    ;

enumExprStruct
    : pathInExpression LCURLYBRACE enumExprFields? RCURLYBRACE
    ;

enumExprFields
    : enumExprField (COMMA enumExprField)* COMMA?
    ;

enumExprField
    : identifier
    | (identifier | tupleIndex) COLON expression
    ;

enumExprTuple
    : pathInExpression LPAREN (expression (COMMA expression)* COMMA?)? RPAREN
    ;

enumExprFieldless
    : pathInExpression
    ;

// 8.2.9
callParams
    : expression (COMMA expression)* COMMA?
    ;

// 8.2.12
// `async |x| …`, `async move || …` (Rust 1.85). [ClarifyDoc addition]
closureExpression
    : KW_ASYNC? KW_MOVE? (OROR | OR closureParameters? OR) (expression | RARROW typeNoBounds blockExpression)
    ;

closureParameters
    : closureParam (COMMA closureParam)* COMMA?
    ;

closureParam
    : outerAttribute* pattern (COLON type_)?
    ;

// 8.2.13
loopExpression
    : loopLabel? (
        infiniteLoopExpression
        | predicateLoopExpression
        | iteratorLoopExpression
    )
    ;

infiniteLoopExpression
    : KW_LOOP blockExpression
    ;

predicateLoopExpression
    : KW_WHILE condition blockExpression
    ;

iteratorLoopExpression
    : KW_FOR pattern KW_IN expression blockExpression
    ;

loopLabel
    : LIFETIME_OR_LABEL COLON
    ;

// 8.2.15
ifExpression
    : KW_IF condition blockExpression (KW_ELSE (blockExpression | ifExpression))?
    ;

// What `if` and `while` test: an expression, a `let` binding, or both chained by `&&` (`if a && let Some(x) = b`,
// Rust 2024). Upstream's separate `if let` / `while let` rules are this with one operand. A chained operand's
// scrutinee may take a `&&` of its own; a parse that only finds calls does not mind. [ClarifyDoc change]
condition
    : conditionOperand (ANDAND conditionOperand)*
    ;

conditionOperand
    : KW_LET pattern EQ expression
    | expression
    ;

// 8.2.16
matchExpression
    : KW_MATCH expression LCURLYBRACE innerAttribute* matchArms? RCURLYBRACE
    ;

// Arms read once each: a block-like body needs no comma, any other is followed by one unless it is the last.
// Upstream's `(arm => body)* arm => expression` read every arm's body to learn whether it was the last one.
// [ClarifyDoc change]
matchArms
    : matchArm FATARROW matchArmBody
    ;

matchArmBody
    : expressionWithBlock (blockTail (COMMA matchArms?)? | COMMA? matchArms?)
    | statementExpression (COMMA matchArms?)?
    ;

matchArm
    : outerAttribute* pattern matchArmGuard?
    ;

matchArmGuard
    : KW_IF expression
    ;

// 9
pattern
    : OR? patternNoTopAlt (OR patternNoTopAlt)*
    ;

patternNoTopAlt
    : patternWithoutRange
    | rangePattern
    ;

patternWithoutRange
    : literalPattern
    | identifierPattern
    | wildcardPattern
    | restPattern
    | referencePattern
    | structPattern
    | tupleStructPattern
    | tuplePattern
    | groupedPattern
    | slicePattern
    | pathPattern
    | macroInvocation
    ;

literalPattern
    : KW_TRUE
    | KW_FALSE
    | CHAR_LITERAL
    | BYTE_LITERAL
    | STRING_LITERAL
    | RAW_STRING_LITERAL
    | BYTE_STRING_LITERAL
    | RAW_BYTE_STRING_LITERAL
    | MINUS? INTEGER_LITERAL
    | MINUS? FLOAT_LITERAL
    ;

identifierPattern
    : KW_REF? KW_MUT? identifier (AT pattern)?
    ;

wildcardPattern
    : UNDERSCORE
    ;

restPattern
    : DOTDOT
    ;

rangePattern
    : rangePatternBound DOTDOTEQ rangePatternBound # InclusiveRangePattern
    | rangePatternBound DOTDOT                    # HalfOpenRangePattern
    | rangePatternBound DOTDOTDOT rangePatternBound # ObsoleteRangePattern
    // `..=5` [ClarifyDoc addition]
    | DOTDOTEQ rangePatternBound                    # RangeToInclusivePattern
    ;

rangePatternBound
    : CHAR_LITERAL
    | BYTE_LITERAL
    | MINUS? INTEGER_LITERAL
    | MINUS? FLOAT_LITERAL
    | pathPattern
    ;

referencePattern
    : (AND | ANDAND) KW_MUT? patternWithoutRange
    ;

structPattern
    : pathInExpression LCURLYBRACE structPatternElements? RCURLYBRACE
    ;

structPatternElements
    : structPatternFields (COMMA structPatternEtCetera?)?
    | structPatternEtCetera
    ;

structPatternFields
    : structPatternField (COMMA structPatternField)*
    ;

structPatternField
    : outerAttribute* (tupleIndex COLON pattern | identifier COLON pattern | KW_REF? KW_MUT? identifier)
    ;

structPatternEtCetera
    : outerAttribute* DOTDOT
    ;

tupleStructPattern
    : pathInExpression LPAREN tupleStructItems? RPAREN
    ;

tupleStructItems
    : pattern (COMMA pattern)* COMMA?
    ;

tuplePattern
    : LPAREN tuplePatternItems? RPAREN
    ;

tuplePatternItems
    : pattern COMMA
    | restPattern
    | pattern (COMMA pattern)+ COMMA?
    ;

groupedPattern
    : LPAREN pattern RPAREN
    ;

slicePattern
    : LSQUAREBRACKET slicePatternItems? RSQUAREBRACKET
    ;

slicePatternItems
    : pattern (COMMA pattern)* COMMA?
    ;

pathPattern
    : pathInExpression
    | qualifiedPathInExpression
    ;

// 10.1
type_
    : typeNoBounds
    | implTraitType
    | traitObjectType
    ;

typeNoBounds
    : parenthesizedType
    | implTraitTypeOneBound
    | traitObjectTypeOneBound
    | typePath
    | tupleType
    | neverType
    | rawPointerType
    | referenceType
    | arrayType
    | sliceType
    | inferredType
    | qualifiedPathInType
    | bareFunctionType
    | macroInvocation
    ;

parenthesizedType
    : LPAREN type_ RPAREN
    ;

// 10.1.4
neverType
    : NOT
    ;

// 10.1.5
tupleType
    : LPAREN ((type_ COMMA)+ type_?)? RPAREN
    ;

// 10.1.6
arrayType
    : LSQUAREBRACKET type_ SEMI expression RSQUAREBRACKET
    ;

// 10.1.7
sliceType
    : LSQUAREBRACKET type_ RSQUAREBRACKET
    ;

// 10.1.13
// `&&T` lexes as one `&&`. [ClarifyDoc addition]
referenceType
    : AND lifetime? KW_MUT? typeNoBounds
    | ANDAND lifetime? KW_MUT? typeNoBounds
    ;

rawPointerType
    : STAR (KW_MUT | KW_CONST) typeNoBounds
    ;

// 10.1.14
bareFunctionType
    : forLifetimes? functionTypeQualifiers KW_FN LPAREN functionParametersMaybeNamedVariadic? RPAREN bareFunctionReturnType?
    ;

functionTypeQualifiers
    : KW_UNSAFE? (KW_EXTERN abi?)?
    ;

bareFunctionReturnType
    : RARROW typeNoBounds
    ;

functionParametersMaybeNamedVariadic
    : maybeNamedFunctionParameters
    | maybeNamedFunctionParametersVariadic
    ;

maybeNamedFunctionParameters
    : maybeNamedParam (COMMA maybeNamedParam)* COMMA?
    ;

maybeNamedParam
    : outerAttribute* ((identifier | UNDERSCORE) COLON)? type_
    ;

maybeNamedFunctionParametersVariadic
    : (maybeNamedParam COMMA)* maybeNamedParam COMMA outerAttribute* DOTDOTDOT
    ;

// 10.1.15
traitObjectType
    : KW_DYN? typeParamBounds
    ;

traitObjectTypeOneBound
    : KW_DYN? traitBound
    ;

implTraitType
    : KW_IMPL typeParamBounds
    ;

implTraitTypeOneBound
    : KW_IMPL traitBound
    ;

// 10.1.18
inferredType
    : UNDERSCORE
    ;

// 10.6
typeParamBounds
    : typeParamBound (PLUS typeParamBound)* PLUS?
    ;

// `impl Trait + use<'a, T>`: precise capturing (Rust 1.82). [ClarifyDoc addition]
typeParamBound
    : lifetime
    | traitBound
    | KW_USE genericArgs
    ;

traitBound
    : QUESTION? forLifetimes? typePath
    | LPAREN QUESTION? forLifetimes? typePath RPAREN
    ;

lifetimeBounds
    : (lifetime PLUS)* lifetime?
    ;

lifetime
    : LIFETIME_OR_LABEL
    | KW_STATICLIFETIME
    | KW_UNDERLINELIFETIME
    ;

// 12.4
simplePath
    : PATHSEP? simplePathSegment (PATHSEP simplePathSegment)*
    ;

simplePathSegment
    : identifier
    | KW_SUPER
    | KW_SELFVALUE
    | KW_CRATE
    | KW_DOLLARCRATE
    ;

pathInExpression
    : PATHSEP? pathExprSegment (PATHSEP pathExprSegment)*
    ;

pathExprSegment
    : pathIdentSegment (PATHSEP genericArgs)?
    ;

pathIdentSegment
    : identifier
    | KW_SUPER
    | KW_SELFVALUE
    | KW_SELFTYPE
    | KW_CRATE
    | KW_DOLLARCRATE
    ;

//TODO: let x : T<_>=something;
// One list: upstream's lifetimes-then-types-then-bindings alternatives described the same input as this one,
// so every generic argument list was ambiguous. [ClarifyDoc change]
genericArgs
    : LT GT
    | LT (genericArg COMMA)* genericArg COMMA? GT
    ;

genericArg
    : lifetime
    | type_
    | genericArgsConst
    | genericArgsBinding
    ;

genericArgsConst
    : blockExpression
    | MINUS? literalExpression
    | simplePathSegment
    ;

genericArgsLifetimes
    : lifetime (COMMA lifetime)*
    ;

genericArgsTypes
    : type_ (COMMA type_)*
    ;

genericArgsBindings
    : genericArgsBinding (COMMA genericArgsBinding)*
    ;

// `Item<'a> = T` (generic associated types) and `Item: Bound` (associated type bounds, Rust 1.79). [ClarifyDoc addition]
genericArgsBinding
    : identifier genericArgs? EQ type_
    | identifier genericArgs? COLON typeParamBounds
    ;

qualifiedPathInExpression
    : qualifiedPathType (PATHSEP pathExprSegment)+
    ;

qualifiedPathType
    : LT type_ (KW_AS typePath)? GT
    ;

qualifiedPathInType
    : qualifiedPathType (PATHSEP typePathSegment)+
    ;

typePath
    : PATHSEP? typePathSegment (PATHSEP typePathSegment)*
    ;

typePathSegment
    : pathIdentSegment PATHSEP? (genericArgs | typePathFn)?
    ;

typePathFn
    : LPAREN typePathInputs? RPAREN (RARROW type_)?
    ;

typePathInputs
    : type_ (COMMA type_)* COMMA?
    ;

// 12.6
visibility
    : KW_PUB (LPAREN ( KW_CRATE | KW_SELFVALUE | KW_SUPER | KW_IN simplePath) RPAREN)?
    ;

// technical
// `union` is a weak keyword: a name everywhere but before a union's name (`let union`, `self.union(a)`).
// [ClarifyDoc addition]
identifier
    : NON_KEYWORD_IDENTIFIER
    | RAW_IDENTIFIER
    | KW_MACRORULES
    | KW_UNION
    ;

keyword
    : KW_AS
    | KW_BREAK
    | KW_CONST
    | KW_CONTINUE
    | KW_CRATE
    | KW_ELSE
    | KW_ENUM
    | KW_EXTERN
    | KW_FALSE
    | KW_FN
    | KW_FOR
    | KW_IF
    | KW_IMPL
    | KW_IN
    | KW_LET
    | KW_LOOP
    | KW_MATCH
    | KW_MOD
    | KW_MOVE
    | KW_MUT
    | KW_PUB
    | KW_REF
    | KW_RETURN
    | KW_SELFVALUE
    | KW_SELFTYPE
    | KW_STATIC
    | KW_STRUCT
    | KW_SUPER
    | KW_TRAIT
    | KW_TRUE
    | KW_TYPE
    | KW_UNSAFE
    | KW_USE
    | KW_WHERE
    | KW_WHILE

    // 2018+
    | KW_ASYNC
    | KW_AWAIT
    | KW_DYN
    // reserved
    | KW_ABSTRACT
    | KW_BECOME
    | KW_BOX
    | KW_DO
    | KW_FINAL
    | KW_MACRO
    | KW_OVERRIDE
    | KW_PRIV
    | KW_TYPEOF
    | KW_UNSIZED
    | KW_VIRTUAL
    | KW_YIELD
    | KW_TRY
    | KW_UNION
    | KW_STATICLIFETIME
    ;

macroIdentifierLikeToken
    : keyword
    | identifier
    | KW_MACRORULES
    | KW_UNDERLINELIFETIME
    | KW_DOLLARCRATE
    | LIFETIME_OR_LABEL
    ;

macroLiteralToken
    : literalExpression
    ;

// macroDelimiterToken: LCURLYBRACE | RCURLYBRACE | LSQUAREBRACKET | RSQUAREBRACKET | LPAREN | RPAREN;
macroPunctuationToken
    : MINUS
    | TILDE
    //| PLUS | STAR
    | SLASH
    | PERCENT
    | CARET
    | NOT
    | AND
    | OR
    | ANDAND
    | OROR
    // already covered by LT and GT in macro | shl | shr
    | PLUSEQ
    | MINUSEQ
    | STAREQ
    | SLASHEQ
    | PERCENTEQ
    | CARETEQ
    | ANDEQ
    | OREQ
    | SHLEQ
    | SHREQ
    | EQ
    | EQEQ
    | NE
    | GT
    | LT
    | GE
    | LE
    | AT
    | UNDERSCORE
    | DOT
    | DOTDOT
    | DOTDOTDOT
    | DOTDOTEQ
    | COMMA
    | SEMI
    | COLON
    | PATHSEP
    | RARROW
    | FATARROW
    | POUND
    //| DOLLAR | QUESTION
    ;

shl
    : LT {this.NextLT()}? LT
    ;

shr
    : GT {this.NextGT()}? GT
    ;
