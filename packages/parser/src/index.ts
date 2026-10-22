export type {
  BodyNode,
  CommandDefinition,
  EntryNode,
  FunctionCall,
  FunctionDefinition,
  FunctionParameter,
  LineInfo,
  NodeBase,
  OptionDefinition,
  OptionReference,
  ParseDiagnostic,
  Position,
  Range,
  SectionNode,
  Severity,
  SkriptDocument,
  StatementNode,
  StructureKind,
  StructureNode,
  VariableReference
} from './types.js'

export { nodePathAt, parseDocument } from './parser.js'
