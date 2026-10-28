/*******************************************************************************
 * The MIT License (MIT)
 *
 * Copyright (c) 2015 Camilo Sanchez (Camiloasc1) 2020 Martin Mirchev (Marti2203)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 * ****************************************************************************
 */

// $antlr-format alignTrailingComments true, columnLimit 150, minEmptyLines 1, maxEmptyLinesToKeep 1, reflowComments false, useTab false
// $antlr-format allowShortRulesOnASingleLine false, allowShortBlocksOnASingleLine true, alignSemicolons hanging, alignColons hanging

parser grammar CPP14Parser;

options {
    superClass = CPP14ParserBase;
    tokenVocab = CPP14Lexer;
}

// Insert here @header for C++ parser.
@header { import { CPP14ParserBase } from "./CPP14ParserBase.js"; }

/*Basic concepts*/

translationUnit
    : declarationSeq? EOF
    ;

/*Expressions*/

// [ClarifyDoc] A name beside a string literal can only be a macro joining strings: `"%" PRIu64 "x"`. A braced
// initializer after a name builds that type: `Club{1, 2}`.
primaryExpression
    : Identifier? literal (Identifier | literal)*
    | This
    | LeftParen expression RightParen
    | FoldLeftParen foldExpression RightParen // [ClarifyDoc] C++17, the `(` retyped by the first pass
    | requiresExpression // [ClarifyDoc] C++20
    | idExpression bracedInitList
    | idExpression
    | MacroName macroArguments // [ClarifyDoc] a macro whose arguments no expression reads: `SIGNAL(moved(Club *))`
    | lambdaExpression
    ;

idExpression
    : unqualifiedId
    | qualifiedId
    ;

unqualifiedId
    : templateId // [ClarifyDoc] first
    | Identifier
    | operatorFunctionId
    | conversionFunctionId
    | literalOperatorId
    | Tilde (className | decltypeSpecifier)
    ;

qualifiedId
    : nestedNameSpecifier Template? unqualifiedId
    ;

nestedNameSpecifier
    : (theTypeName | decltypeSpecifier)? Doublecolon // [ClarifyDoc] a namespace's name is a name too
    | nestedNameSpecifier (Template? simpleTemplateId | Identifier) Doublecolon // [ClarifyDoc] template-id first
    ;

lambdaExpression
    : lambdaIntroducer (TemplateLess templateParameterList TemplateGreater requiresClause?)? (lambdaDeclarator | lambdaSpecifiers)? compoundStatement // [ClarifyDoc] C++20
    ;

// [ClarifyDoc] C++23: specifiers without a parameter list, `[h = std::move(h)] mutable { … }`.
lambdaSpecifiers
    : (Mutable | Constexpr | Consteval | Static)+ exceptionSpecification? attributeSpecifierSeq? trailingReturnType?
    ;

lambdaIntroducer
    : LeftBracket lambdaCapture? RightBracket
    ;

lambdaCapture
    : captureList
    | captureDefault (Comma captureList)?
    ;

captureDefault
    : And
    | Assign
    ;

captureList
    : capture (Comma capture)* Ellipsis?
    ;

capture
    : simpleCapture
    | initCapture
    ;

simpleCapture
    : And? Identifier
    | This
    ;

initCapture
    : And? Ellipsis? Identifier initializer // [ClarifyDoc] C++20 packs, `...args = std::move(args)`
    ;

lambdaDeclarator
    : LeftParen parameterDeclarationClause? RightParen (Mutable | Constexpr | Consteval | Static)* exceptionSpecification? attributeSpecifierSeq? trailingReturnType? requiresClause? // [ClarifyDoc] C++20
    ;

postfixExpression
    : primaryExpression
    | postfixExpression LeftBracket (expression | bracedInitList) RightBracket
    | postfixExpression LeftParen expressionList? RightParen
    | (keywordTypeSpecifier+ | typeNameSpecifier | decltypeSpecifier) ( // [ClarifyDoc] `int(x)`; `Club(x)` is a call, `Club{}` a primary; `decltype(x){1, 2}`
        LeftParen expressionList? RightParen
        | bracedInitList
    )
    | postfixExpression (Dot | Arrow) (Template? idExpression | pseudoDestructorName | Final | Override) // [ClarifyDoc] `p->final()`
    | postfixExpression (PlusPlus | MinusMinus)
    | (Dynamic_cast | Static_cast | Reinterpret_cast | Const_cast) Less theTypeId Greater LeftParen expression RightParen
    | typeIdOfTheTypeId LeftParen (expression | theTypeId) RightParen
    ;

/*
 add a middle layer to eliminate duplicated function declarations
 */

typeIdOfTheTypeId
    : Typeid_
    ;

expressionList
    : initializerList
    ;

pseudoDestructorName
    : nestedNameSpecifier? (theTypeName Doublecolon)? Tilde theTypeName
    | nestedNameSpecifier Template simpleTemplateId Doublecolon Tilde theTypeName
    | Tilde decltypeSpecifier
    ;

unaryExpression
    : postfixExpression
    | (PlusPlus | MinusMinus | Sizeof) unaryExpression
    | unaryOperator castExpression // [ClarifyDoc] `*(Club *) p`: an operator's operand may be a cast
    | Sizeof (LeftParen theTypeId RightParen | Ellipsis LeftParen Identifier RightParen)
    | Alignof LeftParen theTypeId RightParen
    | noExceptExpression
    | Co_await castExpression // [ClarifyDoc] C++20
    | newExpression_
    | deleteExpression
    ;

unaryOperator
    : Or
    | Star
    | And
    | Plus
    | Tilde
    | Minus
    | Not
    ;

newExpression_
    : Doublecolon? New newPlacement? (newTypeId | LeftParen theTypeId RightParen) newInitializer_?
    ;

newPlacement
    : LeftParen expressionList RightParen
    ;

newTypeId
    : typeSpecifierSeq newDeclarator_?
    ;

newDeclarator_
    : pointerOperator newDeclarator_?
    | noPointerNewDeclarator
    ;

noPointerNewDeclarator
    : LeftBracket expression RightBracket attributeSpecifierSeq?
    | noPointerNewDeclarator LeftBracket constantExpression RightBracket attributeSpecifierSeq?
    ;

newInitializer_
    : LeftParen expressionList? RightParen
    | bracedInitList
    ;

deleteExpression
    : Doublecolon? Delete (LeftBracket RightBracket)? castExpression
    ;

noExceptExpression
    : Noexcept LeftParen expression RightParen
    ;

// [ClarifyDoc] A cast where the first pass found a type in the parentheses and an operand after them, and retyped its
// `(`: `(Club *) p`, while `(a) * b` multiplies.
castExpression
    : unaryExpression
    | CastLeftParen theTypeId RightParen castExpression
    ;

pointerMemberExpression
    : castExpression ((DotStar | ArrowStar) castExpression)*
    ;

// [ClarifyDoc] C++17 fold expressions: `(std::cout << ... << args)`, `(check(args) && ...)`.
foldExpression
    : castExpression foldOperator Ellipsis (foldOperator castExpression)?
    | Ellipsis foldOperator castExpression
    ;

foldOperator
    : binaryOperator
    | Comma
    | assignmentOperator
    ;

// [ClarifyDoc] The multiplicative to logical-OR expressions as one flat rule. The same strings parse; the tree loses
// the operators' precedence, which no reading of calls needs, and an operand no longer passes through ten rules (and
// ten predictions) on its way to a cast expression.
binaryExpression
    : pointerMemberExpression (binaryOperator pointerMemberExpression)*
    ;

binaryOperator
    : Star | Div | Mod | Plus | Minus | Greater Greater | Less Less | Less | Greater | LessEqual | GreaterEqual
    | LessEqualGreater | Equal | NotEqual | And | Caret | Or | AndAnd | OrOr
    ;

// [ClarifyDoc] The same in a template argument, where `>` closes the list: `Fixture<kRounds - 1>`. Upstream left it
// to full-context prediction.
templateArgumentExpression
    : pointerMemberExpression (templateArgumentOperator pointerMemberExpression)* (Question templateArgumentExpression Colon templateArgumentExpression)? // [ClarifyDoc] `B ? A : C`
    ;

templateArgumentOperator
    : Star | Div | Mod | Plus | Minus | Less Less | Less | LessEqual | GreaterEqual | LessEqualGreater | Equal | NotEqual
    | And | Caret | Or | AndAnd | OrOr
    ;

conditionalExpression
    : binaryExpression (Question expression Colon assignmentExpression)?
    ;

// [ClarifyDoc] The left side is read as a conditional expression, so one token after it decides: upstream's
// `logicalOrExpression assignmentOperator …` alternative had to read past the whole operand first.
assignmentExpression
    : conditionalExpression (assignmentOperator initializerClause)?
    | Co_yield (assignmentExpression | bracedInitList) // [ClarifyDoc] C++20
    | throwExpression
    ;

assignmentOperator
    : Assign
    | StarAssign
    | DivAssign
    | ModAssign
    | PlusAssign
    | MinusAssign
    | RightShiftAssign
    | LeftShiftAssign
    | AndAssign
    | XorAssign
    | OrAssign
    ;

expression
    : assignmentExpression (Comma assignmentExpression)*
    ;

constantExpression
    : conditionalExpression
    ;

/*Statements*/

// [ClarifyDoc] A declaration or an expression by its first tokens (CPP14ParserBase.IsDeclarationStatement):
// `memcpy(&size, src, n);` would also read as a declaration, `Club c;` as an expression.
statement
    : macroStatement // [ClarifyDoc]
    | macroBlockStatement // [ClarifyDoc]
    | labeledStatement
    | {this.IsDeclarationStatement()}? declarationStatement
    | attributeSpecifierSeq? (
        {!this.IsDeclarationStatement()}? expressionStatement
        | compoundStatement
        | selectionStatement
        | iterationStatement
        | jumpStatement
        | tryBlock
    )
    ;

labeledStatement
    : attributeSpecifierSeq? (Identifier | Case constantExpression | Default) Colon statement
    ;

expressionStatement
    : expression? Semi
    ;

compoundStatement
    : LeftBrace statementSeq? RightBrace
    ;

statementSeq
    : statement+
    ;

selectionStatement
    : If (Constexpr | MacroName)? LeftParen initStatement? condition RightParen statement (Else statement)? // [ClarifyDoc] C++17; `if CONSTEXPR20 (`
    | If Not? Consteval compoundStatement (Else statement)? // [ClarifyDoc] C++23
    | Switch LeftParen initStatement? condition RightParen statement
    ;

// [ClarifyDoc] A statement macro whose arguments no expression reads (a type, a block) or that has no `;`:
// `QFETCH(bool, ok);`, `RULE(OFFSIDE)⏎RULE(HANDBALL)`.
macroStatement
    : {this.IsMacroStatement() && this.SemiAfterMacro()}? (Identifier macroArguments | MacroName macroArguments?) Semi
    | {this.IsMacroStatement() && !this.SemiAfterMacro()}? (Identifier macroArguments | MacroName macroArguments?) // [ClarifyDoc] an optional `;` is also an empty statement
    ;

// [ClarifyDoc] A statement macro taking the statement after it as its body: `SECTION("kickoff") { … }`.
macroBlockStatement
    : {this.IsMacroBlock()}? (Identifier macroArguments | MacroName macroArguments?) statement
    ;

// [ClarifyDoc] C++17: `if (auto it = squad.find(id); it != squad.end())`.
initStatement
    : {this.IsInitStatement()}? (simpleDeclaration | expressionStatement)
    ;

condition
    : expression
    | attributeSpecifierSeq? declSpecifierSeq declarator (
        Assign initializerClause
        | bracedInitList
    )
    ;

iterationStatement
    : While LeftParen condition RightParen statement
    | Do statement While LeftParen expression RightParen Semi
    | For LeftParen (
        forInitStatement condition? Semi expression?
        | forRangeDeclaration Colon forRangeInitializer
    ) RightParen statement
    ;

forInitStatement
    : expressionStatement
    | simpleDeclaration
    ;

forRangeDeclaration
    : attributeSpecifierSeq? declSpecifierSeq (declarator | structuredBinding) // [ClarifyDoc] C++17
    ;

// [ClarifyDoc] C++17: `auto &[id, club] = …`.
structuredBinding
    : (And | AndAnd)? LeftBracket Identifier (Comma Identifier)* RightBracket
    ;

forRangeInitializer
    : expression
    | bracedInitList
    ;

jumpStatement
    : (Break | Continue | SehLeave | (Return | Co_return) (expression | bracedInitList)? | Goto Identifier) Semi // [ClarifyDoc] co_return, MSVC `__leave`
    ;

declarationStatement
    : blockDeclaration
    ;

/*Declarations*/

declarationSeq
    : declaration+
    ;

// [ClarifyDoc] A function definition and a simple declaration share their specifiers (`class Club { … }` included),
// so they are one rule that decides after them: upstream's two alternatives read past a whole class body to choose.
declaration
    : macroFunctionDefinition // [ClarifyDoc]
    | topLevelMacro // [ClarifyDoc]
    | moduleDeclaration // [ClarifyDoc] C++20 modules
    | exportDeclaration
    | attributeSpecifierSeq? declSpecifierSeq? (functionDefinition | declarationTail)
    | otherBlockDeclaration
    | templateDeclaration
    | explicitInstantiation
    | explicitSpecialization
    | linkageSpecification
    | namespaceDefinition
    | emptyDeclaration_
    | attributeDeclaration
    ;

blockDeclaration
    : simpleDeclaration
    | otherBlockDeclaration
    ;

otherBlockDeclaration
    : asmDefinition
    | namespaceAliasDefinition
    | usingDeclaration
    | usingDirective
    | staticAssertDeclaration
    | aliasDeclaration
    | opaqueEnumDeclaration
    | usingEnumDeclaration // [ClarifyDoc] C++20
    ;

usingEnumDeclaration
    : Using Enum nestedNameSpecifier? (simpleTemplateId | Identifier) Semi
    ;

aliasDeclaration
    : Using Identifier attributeSpecifierSeq? Assign theTypeId Semi
    ;

simpleDeclaration
    : attributeSpecifierSeq? declSpecifierSeq? declarationTail
    ;

// [ClarifyDoc] What follows a simple declaration's specifiers; C++17's structured bindings too.
declarationTail
    : (structuredBinding initializer | initDeclaratorList)? Semi
    ;

staticAssertDeclaration
    : Static_assert LeftParen constantExpression (Comma StringLiteral+)? RightParen Semi // [ClarifyDoc] C++17: no message
    ;

emptyDeclaration_
    : Semi
    ;

attributeDeclaration
    : attributeSpecifierSeq Semi
    ;

// [ClarifyDoc] A user name is a type specifier only where a declarator follows it (IsDeclSpecifierType), so a
// constructor's name (`Club(int id);`, `Club::Club()`) is its declarator; the sequence is greedy.
declSpecifier
    : storageClassSpecifier
    | {this.IsDeclSpecifierType()}? typeSpecifier
    | macroSpecifier // [ClarifyDoc]
    | functionSpecifier
    | Friend
    | Typedef
    | Constexpr
    | Consteval // [ClarifyDoc] C++20
    | Constinit
    ;

declSpecifierSeq
    : declSpecifier+ attributeSpecifierSeq?
    ;

storageClassSpecifier
    : Register
    | Static
    | Thread_local
    | Extern
    | Mutable
    ;

functionSpecifier
    : Inline
    | Virtual
    | Explicit
    ;

typedefName
    : Identifier
    ;

// [ClarifyDoc] A class or enum with a body before one without (`class A {` before `class A x`): where SLL
// prediction cannot tell them apart it takes the first alternative. Likewise a template-id before a bare name below.
typeSpecifier
    : classSpecifier
    | enumSpecifier
    | trailingTypeSpecifier
    ;

trailingTypeSpecifier
    : simpleTypeSpecifier
    | elaboratedTypeSpecifier
    | typeNameSpecifier
    | cvQualifier
    ;

typeSpecifierSeq
    : typeSpecifier+ attributeSpecifierSeq?
    ;

trailingTypeSpecifierSeq
    : trailingTypeSpecifier+ attributeSpecifierSeq?
    ;

simpleTypeLengthModifier
    : Short
    | Long
    ;

simpleTypeSignednessModifier
    : Unsigned
    | Signed
    ;

// [ClarifyDoc] The keyword types alone, for what converts or is passed as a macro's type argument.
keywordTypeSpecifier
    : Char
    | Char8
    | Char16
    | Char32
    | Wchar
    | Bool
    | Short
    | Int
    | Long
    | Float
    | Signed
    | Unsigned
    | Double
    | Void
    | Auto
    ;

simpleTypeSpecifier
    : nestedNameSpecifier? theTypeName
    | nestedNameSpecifier Template simpleTemplateId
    | Char
    | Char8 // [ClarifyDoc] C++20
    | Char16
    | Char32
    | Wchar
    | Bool
    | Short
    | Int
    | Long
    | Float
    | Signed
    | Unsigned
    | Float
    | Double
    | Void
    | Auto
    | decltypeSpecifier
    ;

// [ClarifyDoc] One way to a name: upstream's class, enum and typedef names were all `Identifier`.
theTypeName
    : className
    ;

decltypeSpecifier
    : Decltype LeftParen (expression | Auto) RightParen
    ;

elaboratedTypeSpecifier
    : classKey ( // [ClarifyDoc] template-ids first, as for typeSpecifier: `class league::Cup<Club>;`
        nestedNameSpecifier Template? simpleTemplateId
        | simpleTemplateId
        | attributeSpecifierSeq? nestedNameSpecifier? Identifier
    )
    | Enum nestedNameSpecifier? Identifier
    ;

enumName
    : Identifier
    ;

enumSpecifier
    : enumHead LeftBrace (enumeratorList Comma?)? RightBrace
    ;

enumHead
    : enumKey attributeSpecifierSeq? macroSpecifier* (nestedNameSpecifier? Identifier)? enumBase? // [ClarifyDoc]
    ;

opaqueEnumDeclaration
    : enumKey attributeSpecifierSeq? Identifier enumBase? Semi
    ;

enumKey
    : Enum (Class | Struct)?
    ;

enumBase
    : Colon typeSpecifierSeq
    ;

enumeratorList
    : enumeratorDefinition (Comma enumeratorDefinition)*
    ;

enumeratorDefinition
    : enumerator attributeSpecifierSeq? (Assign constantExpression)? // [ClarifyDoc] `kOld [[deprecated]]`
    | (Identifier | MacroName) macroArguments // [ClarifyDoc] a macro listing enumerators: `STATUS_MAP(XX)`
    ;

enumerator
    : Identifier
    ;

namespaceName
    : originalNamespaceName
    | namespaceAlias
    ;

originalNamespaceName
    : Identifier
    ;

// [ClarifyDoc] C++17: `namespace league::cup`.
namespaceDefinition
    : Inline? Namespace (Identifier (Doublecolon Inline? Identifier)*)? LeftBrace namespaceBody = declarationSeq? RightBrace
    ;

namespaceAlias
    : Identifier
    ;

namespaceAliasDefinition
    : Namespace Identifier Assign qualifiedNamespaceSpecifier Semi
    ;

qualifiedNamespaceSpecifier
    : nestedNameSpecifier? namespaceName
    ;

usingDeclaration
    : Using (Typename_? nestedNameSpecifier | Doublecolon) unqualifiedId Ellipsis? Semi // [ClarifyDoc] C++17 `using Bases::operator()...;`
    ;

usingDirective
    : attributeSpecifierSeq? Using Namespace nestedNameSpecifier? namespaceName Semi
    ;

asmDefinition
    : Asm LeftParen StringLiteral RightParen Semi
    ;

linkageSpecification
    : Extern StringLiteral (LeftBrace declarationSeq? RightBrace | declaration)
    ;

attributeSpecifierSeq
    : attributeSpecifier+
    ;

attributeSpecifier
    : LeftBracket LeftBracket attributeList? RightBracket RightBracket
    | alignmentSpecifier
    ;

alignmentSpecifier
    : Alignas LeftParen (theTypeId | constantExpression) Ellipsis? RightParen
    ;

attributeList
    : attribute (Comma attribute)* Ellipsis?
    ;

attribute
    : (attributeNamespace Doublecolon)? Identifier attributeArgumentClause?
    ;

attributeNamespace
    : Identifier
    ;

attributeArgumentClause
    : LeftParen balancedTokenSeq? RightParen
    ;

balancedTokenSeq
    : balancedToken+
    ;

balancedToken
    : LeftParen balancedTokenSeq RightParen
    | LeftBracket balancedTokenSeq RightBracket
    | LeftBrace balancedTokenSeq RightBrace
    | ~(LeftParen | RightParen | LeftBrace | RightBrace | LeftBracket | RightBracket)+
    ;

/*Declarators*/

initDeclaratorList
    : initDeclarator (Comma initDeclarator)*
    ;

initDeclarator
    : declarator initializer?
    ;

declarator
    : pointerDeclarator
    | noPointerDeclarator parametersAndQualifiers trailingReturnType
    ;

pointerDeclarator
    : (pointerOperator Const?)* noPointerDeclarator
    ;

noPointerDeclarator
    : declaratorId attributeSpecifierSeq? macroAttributeSuffix* // [ClarifyDoc]
    | noPointerDeclarator (
        {this.IsParameterList()}? parametersAndQualifiers // [ClarifyDoc] `Random rnd(Seed())` constructs
        | LeftBracket constantExpression? RightBracket attributeSpecifierSeq? macroAttributeSuffix* // [ClarifyDoc]
    )
    | LeftParen pointerDeclarator RightParen
    ;

parametersAndQualifiers
    : LeftParen parameterDeclarationClause? RightParen cvQualifierSeq? refQualifier? exceptionSpecification? attributeSpecifierSeq? macroAttributeSuffix* // [ClarifyDoc]
    ;

trailingReturnType
    : Arrow trailingTypeSpecifierSeq abstractDeclarator?
    ;

pointerOperator
    : (And | AndAnd) attributeSpecifierSeq?
    | nestedNameSpecifier? Star attributeSpecifierSeq? cvQualifierSeq?
    ;

cvQualifierSeq
    : cvQualifier+
    ;

cvQualifier
    : Const
    | Volatile
    ;

refQualifier
    : And
    | AndAnd
    ;

declaratorId
    : Ellipsis? idExpression
    ;

theTypeId
    : typeSpecifierSeq abstractDeclarator?
    ;

abstractDeclarator
    : pointerAbstractDeclarator
    | noPointerAbstractDeclarator? parametersAndQualifiers trailingReturnType
    | abstractPackDeclarator
    ;

pointerAbstractDeclarator
    : pointerOperator* (noPointerAbstractDeclarator | pointerOperator)
    ;

// [ClarifyDoc] `T[]` as in `unique_ptr<Club[]>`; `(T::*)` is no parameter list.
noPointerAbstractDeclarator
    : ({this.IsAbstractParameterList()}? parametersAndQualifiers | LeftParen pointerAbstractDeclarator RightParen | LeftBracket constantExpression? RightBracket attributeSpecifierSeq?) (
        parametersAndQualifiers
        | LeftBracket constantExpression? RightBracket attributeSpecifierSeq?
    )*
    ;

abstractPackDeclarator
    : pointerOperator* noPointerAbstractPackDeclarator
    ;

noPointerAbstractPackDeclarator
    : Ellipsis (
        parametersAndQualifiers
        | LeftBracket constantExpression? RightBracket attributeSpecifierSeq?
    )*
    ;

parameterDeclarationClause
    : parameterDeclarationList (Comma? Ellipsis)?
    | Ellipsis // [ClarifyDoc] `f(...)`
    ;

parameterDeclarationList
    : parameterDeclaration (Comma parameterDeclaration)*
    ;

parameterDeclaration
    : attributeSpecifierSeq? declSpecifierSeq (declarator | abstractDeclarator?) (
        Assign initializerClause
    )?
    ;

// [ClarifyDoc] The declarator and body only: its specifiers are the declaration's around it.
functionDefinition
    : declarator virtualSpecifierSeq? requiresClause? functionBody // [ClarifyDoc] C++20 trailing requires
    ;

// [ClarifyDoc] A macro at file scope that no declaration reads: `TEST_MAIN(Squad)`, `REGISTER(int, 1);`,
// `BENCHMARK(kick)->Arg(1);`.
topLevelMacro
    : {this.IsTopLevelMacro() && this.SemiAfterMacro()}? (Identifier macroArguments | MacroName macroArguments?) ((Arrow | Dot) Identifier macroArguments)* Semi
    | {this.IsTopLevelMacro() && !this.SemiAfterMacro()}? (Identifier macroArguments | MacroName macroArguments?) ((Arrow | Dot) Identifier macroArguments)*
    ;

// [ClarifyDoc] C++20 modules: `module league;`, `export module league.cup:stats;`, `import <vector>;`, `export { … }`.
// `module` and `import` are names elsewhere, keywords only where the first pass says a declaration starts with them.
moduleDeclaration
    : Export? {this.IsModuleKeyword()}? Identifier (moduleName (Colon moduleName)?)? attributeSpecifierSeq? Semi
    | Export? {this.IsImportKeyword()}? Identifier (moduleName | Colon moduleName | TemplateLess ~TemplateGreater* TemplateGreater | Less ~Greater* Greater | StringLiteral) attributeSpecifierSeq? Semi
    ;

moduleName
    : Identifier (Dot Identifier)*
    ;

exportDeclaration
    : Export (LeftBrace declarationSeq? RightBrace | declaration)
    ;

// [ClarifyDoc] A macro the file does not expand that defines a function: `TEST(Cache, Hit) { … }`.
macroFunctionDefinition
    : {this.IsMacroFunction()}? (Identifier | MacroName) macroArguments compoundStatement
    ;

functionBody
    : constructorInitializer? compoundStatement
    | functionTryBlock
    | Assign (Default | Delete) Semi
    ;

initializer
    : braceOrEqualInitializer
    | LeftParen expressionList RightParen
    ;

braceOrEqualInitializer
    : Assign initializerClause
    | bracedInitList
    ;

initializerClause
    : cvQualifier* keywordTypeSpecifier+ (Star | And | AndAnd)* // [ClarifyDoc] a macro's type argument: `SIGNAL(changed(bool))`
    | assignmentExpression
    | bracedInitList
    ;

initializerList
    : designator? initializerClause Ellipsis? (Comma designator? initializerClause Ellipsis?)*
    ;

// [ClarifyDoc] C++20: `{ .id = 7, .name{"Club"} }`.
designator
    : Dot Identifier Assign?
    ;

bracedInitList
    : LeftBrace (initializerList Comma?)? RightBrace
    ;

/*Classes*/

className
    : simpleTemplateId // [ClarifyDoc] first
    | Identifier
    ;

classSpecifier
    : classHead LeftBrace memberSpecification? RightBrace
    ;

classHead
    : classKey attributeSpecifierSeq? macroSpecifier* (classHeadName classVirtSpecifier?)? baseClause?
    | Union attributeSpecifierSeq? macroSpecifier* ( classHeadName classVirtSpecifier?)?
    ;

// [ClarifyDoc] An attribute macro the file does not expand, before a class's name or among a declaration's
// specifiers: `class EXPORT Club : Base`, `__declspec(dllexport) void kick()`.
macroSpecifier
    : {this.IsMacroSpecifier(true)}? (Identifier | MacroName) macroArguments
    | {this.IsMacroSpecifier(false)}? Identifier
    ;

// [ClarifyDoc] The same after a declarator: `void kick() EXCLUSIVE_LOCKS_REQUIRED(mu_);`, `int goals GUARDED_BY(mu);`.
macroAttributeSuffix
    : {this.IsMacroSuffix(true)}? (Identifier | MacroName) macroArguments
    | {this.IsMacroSuffix(false)}? Identifier
    ;

// [ClarifyDoc] A macro's arguments: balanced tokens.
macroArguments
    : LeftParen macroArgument* RightParen
    ;

macroArgument
    : (LeftParen | CastLeftParen | FoldLeftParen) macroArgument* RightParen
    | LeftBracket macroArgument* RightBracket
    | LeftBrace macroArgument* RightBrace
    | ~(LeftParen | CastLeftParen | FoldLeftParen | RightParen | LeftBrace | RightBrace | LeftBracket | RightBracket)
    ;

classHeadName
    : nestedNameSpecifier? className
    ;

classVirtSpecifier
    : Final
    ;

classKey
    : Class
    | Struct
    ;

memberSpecification
    : (memberDeclaration | accessSpecifier Colon)+
    ;

// [ClarifyDoc] A macro as a class member: `Q_OBJECT`, `ROUTE_ADD("/goals", Get)`, `DISABLE_COPY(Club)`.
memberMacro
    : {this.IsMacroMember() && this.SemiAfterMacro()}? (Identifier | MacroName) macroArguments? Semi
    | {this.IsMacroMember() && !this.SemiAfterMacro()}? (Identifier | MacroName) macroArguments?
    ;

memberDeclaration
    : memberMacro // [ClarifyDoc]
    | attributeSpecifierSeq? declSpecifierSeq? (functionDefinition | memberDeclaratorList? Semi) // [ClarifyDoc] as above
    | usingDeclaration
    | usingEnumDeclaration // [ClarifyDoc] C++20
    | staticAssertDeclaration
    | templateDeclaration
    | aliasDeclaration
    | emptyDeclaration_
    ;

memberDeclaratorList
    : memberDeclarator (Comma memberDeclarator)*
    ;

memberDeclarator
    : declarator (
        virtualSpecifierSeq
        | { this.IsPureSpecifierAllowed() }? pureSpecifier
        | { this.IsPureSpecifierAllowed() }? virtualSpecifierSeq pureSpecifier
        | braceOrEqualInitializer
    )
    | declarator
    | Identifier? attributeSpecifierSeq? Colon constantExpression
    ;

virtualSpecifierSeq
    : (virtualSpecifier macroAttributeSuffix*)+ // [ClarifyDoc]
    ;

virtualSpecifier
    : Override
    | Final
    ;

/*
 purespecifier: Assign '0'//Conflicts with the lexer ;
 */

pureSpecifier
    : Assign IntegerLiteral
    ;

/*Derived classes*/

baseClause
    : Colon baseSpecifierList
    ;

baseSpecifierList
    : baseSpecifier Ellipsis? (Comma baseSpecifier Ellipsis?)*
    ;

baseSpecifier
    : attributeSpecifierSeq? (
        baseTypeSpecifier
        | Virtual accessSpecifier? baseTypeSpecifier
        | accessSpecifier Virtual? baseTypeSpecifier
    )
    ;

classOrDeclType
    : nestedNameSpecifier? Template? className // [ClarifyDoc] `pop_back<M...>::template rebind<Club>`
    | decltypeSpecifier
    ;

baseTypeSpecifier
    : classOrDeclType
    ;

// [ClarifyDoc] Qt's sections: `signals:`, `public slots:`.
accessSpecifier
    : (Private | Protected | Public) ({this.IsQtSection()}? Identifier)?
    | {this.IsQtSection()}? Identifier
    ;

/*Special member functions*/

conversionFunctionId
    : Operator conversionTypeId
    ;

conversionTypeId
    : typeSpecifierSeq conversionDeclarator?
    ;

conversionDeclarator
    : pointerOperator conversionDeclarator?
    ;

constructorInitializer
    : Colon memInitializerList
    ;

memInitializerList
    : memInitializer Ellipsis? (Comma memInitializer Ellipsis?)*
    ;

memInitializer
    : memInitializerId (LeftParen expressionList? RightParen | bracedInitList)
    ;

memInitializerId
    : classOrDeclType
    | Identifier
    ;

/*Overloading*/

operatorFunctionId
    : Operator theOperator
    ;

literalOperatorId
    : Operator (StringLiteral Identifier | UserDefinedStringLiteral | UserDefinedLiteral) // [ClarifyDoc] `""_x` lexes as one
    ;

/*Templates*/

templateDeclaration
    : Template TemplateLess templateParameterList TemplateGreater requiresClause? (declaration | conceptDefinition) // [ClarifyDoc] C++20
    ;

// [ClarifyDoc] C++20 concepts and constraints (from grammars-v4's C++23 grammar).
conceptDefinition
    : Concept Identifier attributeSpecifierSeq? Assign binaryExpression Semi
    ;

requiresClause
    : Requires constraintExpression
    ;

constraintExpression
    : constraintPrimary ((AndAnd | OrOr) constraintPrimary)*
    ;

// The primaries a constraint is made of, never through `idExpression`: after `requires X` a declaration may start
// with `::`, and under SLL's merged contexts that made `std ::` ambiguous in every expression. A qualified name first,
// where SLL cannot tell `std` from `std::integral<T>`.
constraintPrimary
    : qualifiedId
    | unqualifiedId
    | LeftParen expression RightParen
    | FoldLeftParen foldExpression RightParen // `requires (Comparable<Ts> && ...)`
    | requiresExpression
    | literal
    | Not constraintPrimary
    ;

requiresExpression
    : Requires (LeftParen parameterDeclarationClause? RightParen)? LeftBrace requirement* RightBrace
    ;

requirement
    : LeftBrace expression RightBrace Noexcept? (Arrow theTypeId)? Semi // compound
    | Typename_ (qualifiedId | unqualifiedId) Semi // type, the qualified name first as in constraintPrimary
    | Requires binaryExpression Semi // nested: any logical-or expression, `requires sizeof(T) == 16;`
    | expression Semi // simple
    ;

templateParameterList
    : templateParameter (Comma templateParameter)*
    ;

templateParameter
    : typeParameter
    | parameterDeclaration
    | {this.IsMacroParameter()}? (Identifier | MacroName) macroArguments // [ClarifyDoc] `ENABLE_IF(cond)` standing for one
    ;

typeParameter
    : ((Template TemplateLess templateParameterList TemplateGreater)? Class | Typename_) (
        Ellipsis? Identifier?
        | Identifier? Assign theTypeId
    )
    ;

// [ClarifyDoc] Only where the first pass found the `>` closing the `<` and retyped both: `a < b` compares.
simpleTemplateId
    : templateName TemplateLess templateArgumentList? TemplateGreater
    ;

templateId
    : simpleTemplateId
    | (operatorFunctionId | literalOperatorId) TemplateLess templateArgumentList? TemplateGreater
    ;

templateName
    : Identifier
    ;

templateArgumentList
    : templateArgument Ellipsis? (Comma templateArgument Ellipsis?)*
    ;

templateArgument
    : theTypeId
    | templateArgumentExpression // [ClarifyDoc]
    | idExpression
    ;

typeNameSpecifier
    : Typename_ nestedNameSpecifier (Identifier | Template? simpleTemplateId)
    ;

explicitInstantiation
    : Extern? Template declaration
    ;

explicitSpecialization
    : Template TemplateLess TemplateGreater declaration
    ;

/*Exception handling*/

tryBlock
    : Try compoundStatement handlerSeq
    | SehTry compoundStatement (SehExcept LeftParen expression RightParen compoundStatement | SehFinally compoundStatement) // [ClarifyDoc] MSVC
    ;

functionTryBlock
    : Try constructorInitializer? compoundStatement handlerSeq
    ;

handlerSeq
    : handler+
    ;

handler
    : Catch LeftParen exceptionDeclaration RightParen compoundStatement
    ;

exceptionDeclaration
    : attributeSpecifierSeq? typeSpecifierSeq (declarator | abstractDeclarator)?
    | Ellipsis
    ;

throwExpression
    : Throw assignmentExpression?
    ;

exceptionSpecification
    : dynamicExceptionSpecification
    | noExceptSpecification
    ;

dynamicExceptionSpecification
    : Throw LeftParen typeIdList? RightParen
    ;

typeIdList
    : theTypeId Ellipsis? (Comma theTypeId Ellipsis?)*
    ;

noExceptSpecification
    : Noexcept LeftParen constantExpression RightParen
    | Noexcept
    ;

/*Preprocessing directives*/

/*Lexer*/

theOperator
    : Co_await // [ClarifyDoc] C++20
    | LessEqualGreater
    | New (LeftBracket RightBracket)?
    | Delete (LeftBracket RightBracket)?
    | Plus
    | Minus
    | Star
    | Div
    | Mod
    | Caret
    | And
    | Or
    | Tilde
    | Not
    | Assign
    | Greater
    | Less
    | GreaterEqual
    | PlusAssign
    | MinusAssign
    | StarAssign
    | DivAssign
    | ModAssign
    | XorAssign
    | AndAssign
    | OrAssign
    | Less Less
    | Greater Greater
    | RightShiftAssign
    | LeftShiftAssign
    | Equal
    | NotEqual
    | LessEqual
    | AndAnd
    | OrOr
    | PlusPlus
    | MinusMinus
    | Comma
    | ArrowStar
    | Arrow
    | LeftParen RightParen
    | LeftBracket RightBracket
    ;

literal
    : IntegerLiteral
    | CharacterLiteral
    | FloatingLiteral
    | StringLiteral
    | BooleanLiteral
    | PointerLiteral
    | UserDefinedLiteral
    ;

