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
import {
  Import,
  methodName,
  setExpandStreamPattern,
} from "@apexlang/codegen/go";
import { isProvider, noCode } from "@apexlang/codegen/utils";
import { InvokersVisitor } from "./invokers_visitor.js";
import { getOperationParts } from "./utilities.js";

export class ImportVisitor extends BaseVisitor {
  visitContextBefore(context: Context): void {
    setExpandStreamPattern("flux.Flux[{{type}}]");
  }

  visitNamespace(context: Context): void {
    const packageName = context.config["package"] || "module";
    const importVisitor = new ImportsVisitor(this.writer);
    context.namespace.accept(context, importVisitor);
    const sortedImports = Array.from(importVisitor.imports).sort();

    this.write(`// Code generated by @apexlang/codegen. DO NOT EDIT.

    package ${packageName}

    import (
      "context"
      "encoding/binary"

      "github.com/WasmRS/wasmrs-go/invoke"
      "github.com/WasmRS/wasmrs-go/payload"
      "github.com/WasmRS/wasmrs-go/proxy"\n`);
    sortedImports.forEach((i) => this.write(`"${i}"\n`));
    this.write(`"github.com/WasmRS/wasmrs-go/transform"\n`);
    const aliases = (context.config.aliases as { [key: string]: Import }) || {};
    for (let a of Object.values(aliases)) {
      if (a.import) {
        this.write(`\t"${a.import}"\n`);
      }
    }
    this.write(`msgpack "github.com/wapc/tinygo-msgpack"
    )\n\n`);

    this.write(`var gCaller invoke.Caller

    func Initialize(caller invoke.Caller) {
      gCaller = caller
    }\n\n`);
  }

  visitFunction(context: Context): void {
    if (!isProvider(context) || noCode(context.operation)) {
      return;
    }
    const invokersVisitor = new InvokersVisitor(this.writer);
    context.operation.accept(context, invokersVisitor);
  }

  visitInterface(context: Context): void {
    if (!isProvider(context) || noCode(context.operation)) {
      return;
    }
    const { interface: iface } = context;

    const providerStructVisitor = new ProviderStructVisitor(this.writer);
    iface.accept(context, providerStructVisitor);
    const providerNewVisitor = new ProviderNewVisitor(this.writer);
    iface.accept(context, providerNewVisitor);
    const invokersVisitor = new InvokersVisitor(this.writer);
    iface.accept(context, invokersVisitor);
  }
}

class ProviderStructVisitor extends BaseVisitor {
  visitInterfaceBefore(context: Context): void {
    const { interface: iface } = context;
    this.write(`type ${iface.name}Impl struct {\n`);
  }

  visitOperation(context: Context): void {
    const { operation } = context;
    this.write(`op${methodName(operation, operation.name)} uint32\n`);
  }

  visitInterfaceAfter(context: Context): void {
    this.write(`}\n\n`);
  }
}

class ProviderNewVisitor extends BaseVisitor {
  visitInterfaceBefore(context: Context): void {
    const { interface: iface } = context;
    this.write(`func New${iface.name}() *${iface.name}Impl {
      return &${iface.name}Impl{\n`);
  }

  visitOperation(context: Context): void {
    const { namespace: ns, interface: iface, operation } = context;
    const parts = getOperationParts(operation);
    this.write(
      `op${methodName(operation, operation.name)}: invoke.Import${
        parts.type
      }("${ns.name}.${iface.name}", "${operation.name}"),\n`
    );
  }

  visitInterfaceAfter(context: Context): void {
    this.write(`}
    }\n\n`);
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