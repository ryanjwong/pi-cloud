export default {
  meta: { name: "pi-cloud" },
  rules: {
    "no-comments": {
      meta: { type: "suggestion", docs: { description: "Disallow comments" } },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === "Line" || comment.type === "Block") context.report({ loc: comment.loc, message: "Comments are not allowed." })
            }
          }
        }
      }
    }
  }
}
