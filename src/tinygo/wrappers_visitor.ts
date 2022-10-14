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
  returnShare,
  translateAlias,
  msgpackRead,
  msgpackVarAccessParam,
  setExpandStreamPattern,
  methodName,
} from "@apexlang/codegen/go";
import {
  capitalize,
  isHandler,
  isObject,
  isVoid,
  noCode,
  uncapitalize,
} from "@apexlang/codegen/utils";
import { primitiveTransformers } from "./constants";

export class WrappersVisitor extends BaseVisitor {
  visitContextBefore(context: Context): void {
    setExpandStreamPattern("flux.Flux[{{type}}]");
  }

  visitOperation(context: Context): void {
    if (!isHandler(context) || noCode(context.operation)) {
      return;
    }
    this.doHandler(context);
  }

  visitFunction(context: Context): void {
    this.doRegister(context);
    this.doHandler(context);
  }

  doRegister(context: Context): void {
    const tr = translateAlias(context);
    const { namespace: ns, operation } = context;
    const handlerName = `${capitalize(operation.name)}Fn`;
    const wrapperName = `${uncapitalize(operation.name)}Wrapper`;
    let rxStyle = "RequestResponse";
    const streams = operation.parameters
      .filter((p) => p.type.kind == Kind.Stream)
      .map((p) => (p.type as Stream).type);
    const streamIn = streams.length > 0 ? streams[0] : undefined;

    if (streams.length > 1) {
      throw new Error(
        `There can only be zero or one stream parameter. Found ${streams.length}.`
      );
    }
    if (streamIn || operation.type.kind == Kind.Stream) {
      rxStyle = streamIn ? "RequestChannel" : "RequestStream";
    }

    this.write(
      `func Register${capitalize(operation.name)}(handler ${handlerName}) {
      invoke.Export${rxStyle}("${ns.name}", "${
        operation.name
      }", ${wrapperName}(handler))
    }\n\n`
    );
  }

  doHandler(context: Context): void {
    const tr = translateAlias(context);
    const { namespace: ns, interface: iface, operation } = context;
    const handlerName = `${capitalize(operation.name)}Fn`;
    const wrapperName = iface
      ? `${uncapitalize(iface.name)}${capitalize(operation.name)}Wrapper`
      : `${uncapitalize(operation.name)}Wrapper`;
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

    var handlerMethodName = "handler";
    if (iface) {
      this.write(
        `func ${wrapperName}(svc ${iface.name}) invoke.${rxStyle}Handler {
          return func(ctx context.Context, ${rxArgs}) ${rxWrapper}[payload.Payload] {\n`
      );
      handlerMethodName = `svc.${methodName(operation, operation.name)}`;
    } else {
      this.write(
        `func ${wrapperName}(handler ${handlerName}) invoke.${rxStyle}Handler {
          return func(ctx context.Context, ${rxArgs}) ${rxWrapper}[payload.Payload] {\n`
      );
    }
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
        `response := ${handlerMethodName}(ctx, ${returnShare(
          unaryParam.type
        )}request${rxHandlerIn})\n`
      );
    } else {
      if (parameters.length > 0) {
        const argsName = iface
          ? `${uncapitalize(iface.name)}${capitalize(operation.name)}Args`
          : `${uncapitalize(operation.name)}Args`;
        this.write(`var inputArgs ${argsName}
        if err := transform.CodecDecode(p, &inputArgs); err != nil {
          return ${rxPackage}.Error[payload.Payload](err)
        }\n`);
      }
      this.write(
        `response := ${handlerMethodName}(${msgpackVarAccessParam(
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
