/*
Copyright 2022 The WasmRS Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { BaseVisitor, Context, Kind } from "@apexlang/core/model";
import { Import } from "@apexlang/codegen/go";
import { WrapperFuncsVisitor } from "./wrappers_visitor.js";

export class ExportVisitor extends BaseVisitor {
  visitNamespace(context: Context): void {
    const packageName = context.config["package"] || "module";
    const importVisitor = new ImportsVisitor(this.writer);
    context.namespace.accept(context, importVisitor);
    const sortedImports = Array.from(importVisitor.imports).sort();

    this.write(`// Code generated by @apexlang/codegen. DO NOT EDIT.

    package ${packageName}

    import (
      "context"

      "github.com/WasmRS/wasmrs-go/invoke"
      "github.com/WasmRS/wasmrs-go/payload"\n`);
    sortedImports.forEach((i) => this.write(`"${i}"\n`));
    this.write(`"github.com/WasmRS/wasmrs-go/transform"\n`);
    const aliases = (context.config.aliases as { [key: string]: Import }) || {};
    for (let a of Object.values(aliases)) {
      if (a.import) {
        this.write(`\t"${a.import}"\n`);
      }
    }
    this.write(`)\n\n`);

    const wrapperFuncs = new WrapperFuncsVisitor(this.writer);
    context.namespace.accept(context, wrapperFuncs);
  }
}

class ImportsVisitor extends BaseVisitor {
  imports: Set<string> = new Set();

  visitFunction(context: Context): void {
    this.visitOperation(context);
  }

  visitOperation(context: Context): void {
    const { operation } = context;
    if (operation.type.kind == Kind.Stream) {
      this.imports.add("github.com/WasmRS/wasmrs-go/rx/flux");
    } else {
      this.imports.add("github.com/WasmRS/wasmrs-go/rx/mono");
    }
  }

  visitParameter(context: Context): void {
    const { parameter } = context;
    if (parameter.type.kind == Kind.Stream) {
      this.imports.add("github.com/WasmRS/wasmrs-go/rx/flux");
    }
  }
}