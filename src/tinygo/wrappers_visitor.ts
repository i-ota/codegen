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

import {
  Context,
  BaseVisitor,
  Kind,
  Primitive,
  Stream,
  Alias,
} from "@apexlang/core/model";
import {
  expandType,
  Import,
  mapParams,
  returnShare,
  translateAlias,
  msgpackRead,
  msgpackVarAccessParam,
  setExpandStreamPattern,
} from "@apexlang/codegen/go";
import {
  capitalize,
  isObject,
  isVoid,
  uncapitalize,
} from "@apexlang/codegen/utils";
import { primitiveTransformers } from "./constants";

export class WrapperVarsVisitor extends BaseVisitor {
  visitFunction(context: Context): void {
    const tr = translateAlias(context);
    const { operation } = context;
    this.write(
      `\tvar ${uncapitalize(operation.name)}Handler func (${mapParams(
        context,
        operation.parameters
      )}) `
    );
    if (!isVoid(operation.type)) {
      this.write(`(${expandType(operation.type, undefined, true, tr)}, error)`);
    } else {
      this.write(`error`);
    }
    this.write(`\n`);
  }

  visitAllOperationsAfter(context: Context): void {
    if (context.config.handlerPreamble == true) {
      this.write(`)\n\n`);
      delete context.config.handlerPreamble;
    }
    super.triggerAllOperationsAfter(context);
  }
}

export class WrapperFuncsVisitor extends BaseVisitor {
  private aliases: { [key: string]: Import } = {};

  visitContextBefore(context: Context): void {
    this.aliases = (context.config.aliases as { [key: string]: Import }) || {};
    setExpandStreamPattern("flux.Flux[{{type}}]");
  }

  visitFunction(context: Context): void {
    const tr = translateAlias(context);
    const { namespace: ns, operation } = context;
    const handlerName = `${capitalize(operation.name)}Fn`;
    const wrapperName = `${uncapitalize(operation.name)}Wrapper`;
    let rxStyle = "RequestResponse";
    let rxWrapper = "mono.Mono";
    let rxArgs = `p payload.Payload`;
    let rxHandlerIn = ``;
    const rxPackage = operation.type.kind == Kind.Stream ? "flux" : "mono";
    const streams = operation.parameters
      .filter((p) => p.type.kind == Kind.Stream)
      .map((p) => (p.type as Stream).type);
    const parameters = operation.parameters.filter(
      (p) => p.type.kind != Kind.Stream
    );
    const streamIn = streams.length > 0 ? streams[0] : undefined;

    if (streams.length > 1) {
      throw new Error(
        `There can only be zero or one stream parameter. Found ${streams.length}.`
      );
    }
    if (streamIn || operation.type.kind == Kind.Stream) {
      rxStyle = streamIn ? "RequestChannel" : "RequestStream";
      rxWrapper = "flux.Flux";
    }
    if (streamIn) {
      rxArgs += `, in flux.Flux[payload.Payload]`;
      if (streamIn.kind == Kind.Primitive) {
        const prim = streamIn as Primitive;
        rxHandlerIn = `, flux.Map(in, ${primitiveTransformers.get(
          prim.name
        )}.Decode)`;
      } else {
        rxHandlerIn = `, flux.Map(in, transform.MsgPackDecode[${expandType(
          streamIn,
          undefined,
          false,
          tr
        )}])`;
      }
    }

    this.write(
      `func Register${capitalize(operation.name)}(handler ${handlerName}) {
      invoke.Register${rxStyle}Handler("${ns.name}", "${
        operation.name
      }", ${wrapperName}(handler))
    }\n\n`
    );
    this.write(
      `func ${wrapperName}(handler ${handlerName}) invoke.${rxStyle}Handler {
        return func(ctx context.Context, ${rxArgs}) ${rxWrapper}[payload.Payload] {\n`
    );
    if (operation.isUnary() && parameters.length > 0) {
      const unaryParam = parameters[0];
      if (unaryParam.type.kind == Kind.Enum) {
        const unaryParamExpanded = expandType(
          unaryParam.type,
          undefined,
          false,
          tr
        );
        this.write(`enumVal, err := transform.Int32.Decode(p)
        if err != nil {
          return ${rxPackage}.Error[payload.Payload](err)
        }
        request := ${unaryParamExpanded}(enumVal)\n`);
      } else if (unaryParam.type.kind == Kind.Alias) {
        const a = unaryParam.type as Alias;
        const primitiveExpanded = expandType(a.type, undefined, false, tr);
        const unaryParamExpanded = expandType(
          unaryParam.type,
          undefined,
          false,
          tr
        );
        this.write(`aliasVal, err := transform.${capitalize(
          primitiveExpanded
        )}.Decode(p)
          if err != nil {
            return ${rxPackage}.Error[payload.Payload](err)
          }
          request := ${unaryParamExpanded}(aliasVal)\n`);
      } else if (isObject(unaryParam.type)) {
        this.write(`var request ${expandType(
          operation.unaryOp().type,
          undefined,
          false,
          tr
        )}
        if err := transform.CodecDecode(p, &request); err != nil {
          return ${rxPackage}.Error[payload.Payload](err)
        }\n`);
      } else {
        this.write(
          `decoder := msgpack.NewDecoder(p.Data())
          ${msgpackRead(
            context,
            false,
            "request",
            true,
            "",
            unaryParam.type,
            false
          )}`
        );
        this.write(`if err != nil {
          return ${rxPackage}.Error[payload.Payload](err)
        }\n`);
      }
      this.write(
        `response := handler(ctx, ${returnShare(
          unaryParam.type
        )}request${rxHandlerIn})\n`
      );
    } else {
      if (parameters.length > 0) {
        this.write(`var inputArgs ${capitalize(operation.name)}Args
        if err := transform.CodecDecode(p, &inputArgs); err != nil {
          return ${rxPackage}.Error[payload.Payload](err)
        }\n`);
      }
      this.write(
        `response := handler(${msgpackVarAccessParam(
          "inputArgs",
          parameters
        )}${rxHandlerIn})\n`
      );
    }
    let returnType = operation.type;
    if (returnType.kind == Kind.Stream) {
      returnType = (returnType as Stream).type;
    }
    if (isVoid(returnType)) {
      this.visitWrapperBeforeReturn(context);
      this.write(`return []byte{}, nil\n`); // TODO
    } else if (returnType.kind == Kind.Primitive) {
      const prim = returnType as Primitive;
      this.write(
        `return ${rxPackage}.Map(response, ${primitiveTransformers.get(
          prim.name
        )}.Encode)`
      );
    } else {
      this.visitWrapperBeforeReturn(context);
      this.write(
        `return ${rxPackage}.Map(response, transform.MsgPackEncode[${expandType(
          operation.type,
          undefined,
          false,
          tr
        )}])\n`
      );
    }
    this.write(`}
  }\n\n`);
  }

  visitWrapperBeforeReturn(context: Context): void {
    this.triggerCallbacks(context, "WrapperBeforeReturn");
  }
}
