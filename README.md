# What is it?
**CppBuild** is a multi-step incremental build command line tool based on JSON, string templates and [glob syntax](https://en.wikipedia.org/wiki/Glob_(programming)).  
**CppBuild** has originally been designed to work together with the popular [vscode-cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extension and uses its variables combined with its own build steps.  
Since version 1.2.0 **CppBuild** can be used without [vscode-cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) and is not limited to C/C++ builds.

# Why?
While working on C/C++ for embedded devices in VS Code I wanted to simplify multi-step build process configuration and maintenance. Also, I wanted to eliminate duplication of the settings (**include paths** and **defines**) between `c_cpp_properties.json` and widely used MAKE/CMake files. Although these tools are industry standard, I am not a big fan of them. All that led me to the development of a completely new build tool.  
Since [ms-vscode.cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extension is popular and widely used, I adjusted to the status quo and used `c_cpp_properties.json` as it was, instead of supplying my own settings via [vscode-cpptools-api](https://github.com/Microsoft/vscode-cpptools-api).  
Initially **CppBuild** had to use [vscode-cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) `c_cpp_properties.json` file. This dependency has been eliminated since version 1.1.0 and now **CppBuild** can be used to run any other builds.

# What does it do?
The way **CppBuild** works is very simple. The tool executes build steps, by default defined in `c_cpp_build.json` file. Each build step defines `command` to be executed. `command` is actually a string template where both single and multi-value ($$) variables like `${fileName}`, `${outputDirectory}` or `$${defines}` can be used. If `filePattern` is specified as well the `command` will be executed for every file matching the pattern. In addition, a build step can define one or more **build types** like `debug` or `release`. Build types simply define additional variables, typically compiler options, to be added or changed.

When **CppBuild** is used with [vscode-cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools), **includePath**, **defines** and **forcedInclude** multi-value variables defined in `c_cpp_properties.json` config file can be used in build step `command`. For this to happen, the corresponding configurations, which have the same name, must be present in both `c_cpp_build.json` and `c_cpp_properties.json` files.

Additional variables may be supplied on all levels and as command line arguments.

# How to use it?
Install: `npm install cppbuild -g`  

* From VS Code folder run: `cppbuild <config name> [build type] -w [workspace root]`  
**cppbuild** will use `c_cpp_build.json` and `c_cpp_properties.json` files from `.vscode` folder in current or specified workspace root.

* Otherwise run: `cppbuild <config name> [build type] [-b <JSON build file>]`  
By default, **cppbuild** will use `c_cpp_build.json` file from local folder or any other file specified.

The only required argument is **config name** - one of the configurations defined in build file. **Build type** name can be supplied optionally.

For more options run: `cppbuild --help`

# Configuration file syntax
[c_cpp_build.json](c_cpp_build.json) file defines multiple configurations, build types and build steps.  
See the content of the [c_cpp_build.json](c_cpp_build.json) file for a sample build configuration.

Sample build step:
```
"name": "C++ Compile",
"filePattern": "**/*.cpp",
"outputFile": "build/${buildTypeName}/${fileDirectory}/${fileName}.o",
"command": "g++ -c ${buildTypeParams} (-I[$${includePath}]) (-D$${defines}) [${filePath}] -o [${outputFile}]"
```
Sample build type:
```
"name": "debug",
"params": { "buildTypeParams": "-O0 -g" }
```

Here is how it works:
1. **command** (here g++ compiler) is run for every file matching **filePattern** (**/*.cpp).
1. `(-I[$${includePath}])` and `(-D$${defines})` define sub-templates repeated for every **includePath** and **defines** value listed in corresponding configuration from **c_cpp_properties.json** file.
1. `${fileName}`, `${filePath}` and `${fileDirectory}` are substituted by the name, path and relative directory of the file being processed.
1. `${outputFile}` value is built as defined by **outputFile** template. Note that **outputFile** can be build using relative path of the file being processed. As a result, inside the output **build** folder directory structure will resemble the input directory structure. Required directory will be created if it does not exists.
1. `${buildTypeParams}` is defined in **build type** section. For DEBUG build type `-O0 -g` switches will be added.
1. Strings in `[]` are treated as paths and will be quoted if path contains whitespace. Path separators may be modified.
1. Be default, if **outputFile** already exists and is more recent than the processed input file, build for this file will not be performed. As a result, only modified files will be built (incremental build).

# Notes
1. **filePattern**/**fileList** build step properties use [glob syntax](https://en.wikipedia.org/wiki/Glob_(programming)). Tool internally relies on [glob module](https://github.com/isaacs/node-glob) so more advanced file patterns and exclusions are supported.
1. **filePattern**/**fileList** are mutually exclusive. If **filePattern** is used, command will be executed for every file matching the pattern.  
In contrast, **fileList** only populates `$${fileDirectory}`, `$${filePath}` and `$${fileName}` multi-valued variables.
1. Standard `${name}` variable syntax is used for single-valued variables. `$${name}` denotes multi-valued variable.
1. Strings in `()` (e.g. `(-D$${defines})`) are sub-templates repeated for every variable value inside. Therefore, only one multi-valued variable inside `()` is allowed. If sub-template contains path or file name which may require quoting, `[]` can be used instead, e.g. `[$${fileName}.cpp]`.
1. Environment values (`${env:name}`) and standard variables **workspaceRoot**/**workspaceFolder** and **workspaceRootFolderName** can be used.
1. **filePattern** and **outputDirectory** are not required. Command without **filePattern** will be executed just once.
1. **build types** do not have to be defined - they are optional and they can define multiple additional variables. If specified, **buildTypeName** variable is added.
1. If **outputDirectory** or **outputFile** are specified, the required directory will be created if it does not exist.
1. **includePath** and **forcedInclude** multi-value variables defined in `c_cpp_properties.json` can contain [glob patterns](https://en.wikipedia.org/wiki/Glob_(programming)). Paths will be expanded.
1. Variables can be defined globally, on configuration, task and build type level. Low level variables override higher levels variables. Command line provided variables have the highest priority.
1. Variable values can contain other variables.
1. JSON file can contain comments - internally [MS JSONC](https://github.com/microsoft/node-jsonc-parser) parser is used.
1. **CppBuild** can be run without `c_cpp_properties.json` file. Use `-p` flag with no file name.
1. It is possible to provide root folder, alternative configuration file paths and names using command line options.  
Run: `cppbuild --help` for all supported options.

# Predefined variables
The following variables have been predefined:
1. **workspaceRoot**/**workspaceFolder** (full folder path) and **workspaceRootFolderName** (just the folder name)
1. **configName** - selected build configuration name
1. **buildTypeName** - selected build type name (optional)
1. **filePath** (relative file path), **fileDirectory** (relative file directory), **fileName** (file name without extension), **fullFileName** (file name with extension), **fileExtension** (without .)  
The above variables are available when **filePattern** or **fileList** build step property is defined. When **filePattern** is defined, variables have single values and `command` is executed for every file matching the specified pattern. When **fileList** is defined, variables have multiple values but build step `command` is executed just once.
1. **outputDirectory** - output directory, available when build step **outputDirectory** template is specified. Path will be created if it does not exist.
1. **includePath**, **defines** and **forcedInclude** - multi-valued variables populated from `c_cpp_properties.json` (if used)
1. **outputFile** - available only when **filePattern** is specified.

# Further improvements
I am certain this tool could be further improved in many ways, including both functionality and code structure. This is the second TypeScript program I have ever written (the first one was "hello world" app).  
For example, multi-valued variables currently cannot be specified from command line.

Please do not hesitate to suggest fixes and improvements. Pull requests are more than welcome.

Finally, if you find this tool useful, please give it a star. This way others will be able to find it more easily.

# Release notes
* 1.0 Initial release
* 1.1 `params` can be added on all levels, tool can work without C/C++ extension and `c_cpp_properties.json` file.
* 1.2 Added support for incremental builds and `outputFile` build step property.