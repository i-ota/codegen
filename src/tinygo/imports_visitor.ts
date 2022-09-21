import { ImportsVisitor as GoImportsVisitor } from "@apexlang/codegen/go";
import {
  AnyType,
  Context,
  Kind,
  Operation,
  Stream,
} from "@apexlang/core/model";

export class ImportsVisitor extends GoImportsVisitor {
  checkType(context: Context, type: AnyType): void {
    if (type.kind == Kind.Stream) {
      this.addType("flux", {
        type: "flux.Flux",
        import: "github.com/WasmRS/wasmrs-go/rx/flux",
      });
      type = (type as Stream).type;
    }
    super.checkType(context, type);
  }

  visitFunction(context: Context): void {
    this.checkReturn(context.operation);
    super.visitFunction(context);
  }

  visitOperation(context: Context): void {
    this.checkReturn(context.operation);
    super.visitOperation(context);
  }

  checkReturn(operation: Operation) {
    if (operation.type.kind != Kind.Stream) {
      this.addType("mono", {
        type: "mono.Mono",
        import: "github.com/WasmRS/wasmrs-go/rx/mono",
      });
    }
  }
}
