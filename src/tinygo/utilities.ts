import {
  Kind,
  Stream,
  Operation,
  Parameter,
  AnyType,
} from "@apexlang/core/model";

export interface OperationParts {
  type: string;
  unaryIn?: Parameter;
  parameters: Parameter[];
  streamIn?: AnyType;
  returns: AnyType;
  returnPackage: string;
}

export function getOperationParts(operation: Operation): OperationParts {
  let rxType = "RequestResponse";
  const parameters = operation.parameters.filter(
    (p) => p.type.kind != Kind.Stream
  );
  const streams = operation.parameters
    .filter((p) => p.type.kind == Kind.Stream)
    .map((p) => (p.type as Stream).type);
  const streamIn = streams.length > 0 ? streams[0] : undefined;

  if (streams.length > 1) {
    throw new Error(
      `There can only be zero or one stream parameter. Found ${streams.length}.`
    );
  }
  var returns = operation.type;
  if (streamIn || operation.type.kind == Kind.Stream) {
    rxType = streamIn ? "RequestChannel" : "RequestStream";
    returns = (operation.type as Stream).type;
  }

  const unaryIn =
    operation.isUnary() && parameters.length > 0 ? parameters[0] : undefined;

  const returnPackage = operation.type.kind == Kind.Stream ? "flux" : "mono";

  return {
    type: rxType,
    unaryIn: unaryIn,
    parameters: parameters,
    streamIn: streamIn,
    returns: returns,
    returnPackage: returnPackage,
  };
}
