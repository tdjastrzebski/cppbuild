# What is it?
**cppbuild** is a simple command line multi-step build tool made for building VS Code C/C++ projects based on popular [ms-vscode.cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) settings and its own build steps.

# Why?
While working on C/C++ for embedded devices in VS Code I wanted to simplify multi-step build process configuration and maintenance. Also, I wanted to eliminate setting duplication (include paths and defines) between `c_cpp_properties.json` and widely used MAKE/CMake files. Although these tools are industry standard, I am not a big fan of them. All that led me to the development of a completely new build tool.  
Since [ms-vscode.cpptools](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) extension is popular and widely used, I adjusted to the status quo and used `c_cpp_properties.json` as it was, instead of supplying my own settings via [vscode-cpptools-api](https://github.com/Microsoft/vscode-cpptools-api).

# What does it do?
The tool reads **includePath**, **defines** and **forcedInclude** variables from standard [c_cpp_properties.json](c_cpp_properties.json) config file and then performs build steps defined in its own [c_cpp_build.json](c_cpp_build.json) file. Typically, both files are placed in `.vscode` folder.  
[c_cpp_properties.json](c_cpp_properties.json) file may contain several different configurations. Corresponding configurations, which have the same name, must be present in [c_cpp_build.json](c_cpp_build.json) file.  
Additional variables may be supplied - see [Notes](#Notes).

# How to use it?
Install: `npm install cppbuild -g`  
and run: `cppbuild <config name>`  
The only required argument is **config name** - one of the configurations defined in [c_cpp_properties.json](c_cpp_properties.json) and [c_cpp_build.json](c_cpp_build.json) files.
> Note: config names in both files have to match.

For more options run: `cppbuild --help`

# Configuration file syntax
[c_cpp_build.json](c_cpp_build.json) file defines multiple configurations, build types and build steps.  
See the [c_cpp_build.json](c_cpp_build.json) for a sample build configuration.

Sample build type:
```
"name": "DEBUG",
"params": {
    "buildTypeParams": "-O0 -g"
}
```
Sample build step:
```
"name": "C++ Compile",
"filePattern": "**/*.cpp",
"outputDirectory": "build/${buildTypeName}/${fileDirectory}",
"command": "g++ -c ${buildTypeParams} (-I[$${includePath}]) (-D$${defines}) (-include [$${forcedInclude}]) [${filePath}] -o [${outputDirectory}/${fileName}.o]"
```
Here is how it works:
1. **command** is run for every file matching **filePattern**.  
1. `-I[$${includePath}]`, `-D$${defines}` and `-include [$${forcedInclude}]` are repeated for every **includePath**, **defines** and **forcedInclude** value listed in [c_cpp_properties.json](c_cpp_properties.json) file.  
1. `${fileDirectory}`, `${filePath}`, `${fileName}` are replaced by the name, path and relative directory of the file being processed.
1. `${outputDirectory}` value is built as defined by **outputDirectory** template.
1. `${buildTypeParams}` is defined in build type section.
1. Strings in `[]` are treated as paths and will be quoted if path contains whitespace.

# Notes
1. **filePattern**/**fileList** use Glob syntax. Tool internally relies on [Glob](https://github.com/isaacs/node-glob) so more advanced file patterns and exclusions are supported.
1. **filePattern**/**fileList** are mutually exclusive. If **filePattern** is used, command will be executed for every file. In contrast, **fileList** only populates `$${fileDirectory}`, `$${filePath}` and `$${fileName}` multi-valued variables.
1. Standard `${name}` variable syntax is used. `$${name}` denotes multi-valued variable.
1. Strings in `()` (e.g. `(-D$${defines})`) are repeated for every variable value inside. Therefore, only one multi-valued variable inside `()` is allowed. If sub-template contains path or file name which may require quoting `[]` can be used instead. E.g. `[$${fileName}.cpp]`.
1. Environment values (`${env:name}`) and standard variables **workspaceRoot**/**workspaceFolder** and **workspaceRootFolderName** can be used.
1. **filePattern** and **outputDirectory** are not required. Command without **filePattern** will be executed just once.
1. **build types** do not have to be defined - they are optional and they can define multiple additional variables. If specified, **buildTypeName** variable is added.
1. Variables can be supplied and overridden using command line options.
1. It is possible to provide root folder, alternative configuration file paths and names using command line options. Run: `cppbuild --help` for all supported options.
1. JSON file can contain comments - internally [MS JSONC](https://github.com/microsoft/node-jsonc-parser) parser is used.

# Further improvements
I am certain this tool could be further improved in many ways, including both functionality and code structure. This is the second TypeScript program I have ever written (the first one was "hello world" app).  
Probably it would be nice to be able to supply additional multi-valued variables and values - both from command line and build type.  
It may be feasible to remove dependency on `c_cpp_properties.json` and **ms-vscode.cpptools** all together. This way this tool could be used for any build - not only C/C++.

Please do not hesitate to suggest fixes and improvements. Pull requests are more than welcome.

Finally, if you find this tool useful please give it a star. This way others will be able to find it more easily.